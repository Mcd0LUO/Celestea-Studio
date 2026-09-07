//! celestea-studio — local web UI over the celestea-runtime engine (W215).
//!
//! One Rust binary: axum HTTP server on 127.0.0.1:3777 that serves the
//! TypeScript+Vite frontend build (frontend/dist/) and exposes turn endpoints.
//! POST /api/turn drives one Runtime::run_turn with a per-turn EventSink;
//! every LoopEvent is mapped to an SSE event on GET /api/events.
//!
//! W218: static root moved from the embedded legacy frontend/*.js to
//! frontend/dist/ (Vite output; a "build the frontend first" hint page is
//! served when dist/ is absent). The engine's 16-step default cap is raised
//! to 4096 at compose time (the agent loop runs steps in `0..max_steps`, so a
//! "no limit" is only expressible as a high cap). A live statusline
//! ({model, reasoning_effort, steps, tokens_per_sec, context_usage}) is
//! computed by the backend and delivered both via SSE status events
//! (start / progress / completed / cancelled / error / lagged carry it) and
//! through GET /api/status as the fallback channel.
//!
//! W237: no global main session — sessions are per-workspace DIRECTORIES
//! (cli-main.jsonl inside; the engine's PersistentSessionLog replay unit),
//! listed/created/switched through workspaces.rs + a workspaces.json
//! registry. The persisted active session is restored before the first
//! compose: CELESTEA_SESSION_DIR names the active session directory and the
//! engine replays it — zero engine changes.
//!
//! SSE event names (mirroring the engine LoopEvent variants):
//!   - text        {"delta": String}
//!   - thinking    {"delta": String}
//!   - tool        {"id", "name", "args"}
//!   - tool_result {"id", "ok", "value", "render", "error", "decision"}
//!   - done        {"text", "tool_calls": [...]}
//!   - status      {"phase": "start|progress|completed|cancelled|error|lagged",
//!                  "statusline": {...}, ...}
//! Every SSE event carries {"turn": N, "seq": M, "payload": {...}}.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{OriginalUri, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, Mutex};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use celestea_core::{Content, ToolDecision};
use celestea_runtime::{
    load_dotenv, merge_profile, resolve_base_url, resolve_profile, EventSink, LoopEvent,
    Profile, Runtime, SessionEvent, SessionLog, TurnOutcome,
};
mod api;
/// W236: model-provider management (providers.json + probe + default-model
/// hot-apply).
mod providers;
/// W237: workspace registry (workspaces.json) + per-session directories
/// over CELESTEA_SESSION_DIR.
mod workspaces;

/// Default bind address (loopback only; access via ssh -L tunnel).
const DEFAULT_BIND: &str = "127.0.0.1:3777";
/// Engine default config names, resolved from the process cwd.
const PRIMARY_CONFIG: &str = "celestea.toml";
const LEGACY_CONFIG: &str = "profile.json";

/// W218: static root — the TypeScript+Vite build output (frontend/dist).
const STATIC_ROOT: &str = "frontend/dist";
/// W218: step-cap floor applied at compose time. The engine agent loop drives
/// `for _step in 0..max_steps`, so max_steps=0 means *zero* steps (not
/// unlimited); removing the limit is therefore a high cap. 4096 covers
/// realistic long turns while still bounding runaway loops.
const MIN_STEPS: usize = 4096;
/// W218: context-window size used for the estimated usage ratio (contract).
const CONTEXT_WINDOW: u64 = 1_000_000;
/// W218: cadence of the SSE status "progress" events during a turn.
const STATUS_TICK: Duration = Duration::from_secs(2);
/// W218: sliding-window length for tokens_per_sec.
const RATE_WINDOW: Duration = Duration::from_secs(5);

// ---- W225: deployment model / effort catalog -------------------------------

/// W225: one entry of the deployment model catalog — the models the studio
/// offers (snapshot of the local provider's "celestea" group; mirrors the
/// DSH session.models listing). The 'reasoning' flag marks models that
/// accept a reasoning effort; efforts are meaningful only for those. The
/// catalog is static on purpose: deterministic, no upstream dependency at
/// startup; extend AVAILABLE_MODELS to add a model.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelMeta {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) reasoning: bool,
}

pub(crate) const AVAILABLE_MODELS: &[ModelMeta] = &[
    ModelMeta { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true },
    ModelMeta { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", reasoning: true },
    ModelMeta { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
    ModelMeta { id: "mimo-v2.5", name: "Mimo V2.5", reasoning: false },
    ModelMeta { id: "muse-spark-1.2-contributor", name: "Muse Spark", reasoning: false },
    ModelMeta { id: "glm-5.3", name: "GLM 5.3", reasoning: false },
    ModelMeta { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false },
];

/// W225: effort tiers the studio exposes. Engine mapping: low -> Low,
/// high -> High, max -> High (the engine's ceiling; POST also accepts the
/// engine-native "medium" and "off"/null for back-compat with celestea.toml).
pub(crate) const AVAILABLE_EFFORTS: &[&str] = &["low", "high", "max"];

/// W237: serializes tests that mutate process-global env vars before an
/// engine compose (CELESTEA_SESSION_DIR / API-key env channels) — cargo
/// test threads share one process env.
#[cfg(test)]
pub(crate) static COMPOSE_ENV_LOCK: StdMutex<()> = StdMutex::new(());

/// W225: engine default system prompt (restored when system_prompt is cleared).
pub(crate) const DEFAULT_SYSTEM_PROMPT: &str =
    "You are celestea, an AI agent. You are concise, accurate and direct.";

/// W225: reasoning-capability lookup (None = unknown id on a custom endpoint;
/// POST validation treats unknown ids as reasoning-capable).
pub(crate) fn model_reasoning(id: &str) -> Option<bool> {
    AVAILABLE_MODELS.iter().find(|m| m.id == id).map(|m| m.reasoning)
}

/// W225: the 'available' block of the config contract — models + effort tiers.
pub(crate) fn available_json() -> Value {
    json!({
        "models": AVAILABLE_MODELS
            .iter()
            .map(|m| json!({"id": m.id, "name": m.name, "reasoning": m.reasoning}))
            .collect::<Vec<Value>>(),
        "efforts": AVAILABLE_EFFORTS,
    })
}

/// W225: sanitized config JSON — the shared body of GET /api/config and the
/// POST /api/config response. Never carries an api key (only the KEY's
/// env-var NAME is exposed) and never persists one.
pub(crate) fn sanitized_config(profile: &Profile, base_url: &str) -> Value {
    json!({
        "model": profile.model.clone(),
        "base_url": base_url,
        "max_steps": profile.max_steps,
        "max_parallel_tool_calls": profile.max_parallel_tool_calls,
        "reasoning_effort": serde_json::to_value(profile.reasoning_effort).unwrap_or(Value::Null),
        "max_output_tokens": profile.max_output_tokens,
        "context_window": profile.context_window_tokens,
        "system_prompt": profile.system_prompt.clone(),
        "api_key_env": profile.api_key_env.clone(),
        "available": available_json(),
    })
}

/// W225: the current Profile as full profile JSON (every documented key;
/// optional None fields omitted), so POST /api/config can merge partial
/// overrides through the engine's own lenient merge before re-composing.
pub(crate) fn profile_to_json(profile: &Profile) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("model".to_string(), Value::String(profile.model.clone()));
    m.insert("system_prompt".to_string(), Value::String(profile.system_prompt.clone()));
    m.insert("max_steps".to_string(), json!(profile.max_steps));
    m.insert("max_parallel_tool_calls".to_string(), json!(profile.max_parallel_tool_calls));
    m.insert("context_window_tokens".to_string(), json!(profile.context_window_tokens));
    m.insert("context_trim_threshold".to_string(), json!(profile.context_trim_threshold));
    m.insert("context_keep_recent".to_string(), json!(profile.context_keep_recent));
    if let Some(b) = &profile.base_url {
        m.insert("base_url".to_string(), Value::String(b.clone()));
    }
    if let Some(e) = profile.reasoning_effort {
        // engine-level serialization: "low" | "medium" | "high"
        m.insert("reasoning_effort".to_string(), serde_json::to_value(e).unwrap_or(Value::Null));
    }
    if let Some(t) = profile.max_output_tokens {
        m.insert("max_output_tokens".to_string(), json!(t));
    }
    m.insert("api_key_env".to_string(), Value::String(profile.api_key_env.clone()));
    if let Some(f) = &profile.api_key_file {
        m.insert("api_key_file".to_string(), Value::String(f.clone()));
    }
    Value::Object(m)
}

/// One turn-level event on the broadcast bus; kind is the SSE event name.
#[derive(Clone, Debug)]
struct BusEvent {
    kind: &'static str,
    data: Value,
}

/// W218 statusline tracker: event-counted steps plus a sliding-window
/// char-rate over text/thinking deltas (the tokens_per_sec estimate).
pub(crate) struct StatusTracker {
    steps: AtomicU64,
    rate: StdMutex<RateWindow>,
}

impl StatusTracker {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            steps: AtomicU64::new(0),
            rate: StdMutex::new(RateWindow::default()),
        })
    }

    /// New-turn baseline: clear steps + rate window.
    pub(crate) fn reset(&self) {
        self.steps.store(0, Ordering::Relaxed);
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// Record one output delta (text/thinking) into the rate window.
    pub(crate) fn add_chars(&self, chars: u64) {
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(chars, Instant::now());
    }

    /// Record one step (a tool / tool_result event).
    pub(crate) fn add_step(&self) {
        self.steps.fetch_add(1, Ordering::Relaxed);
    }

    /// Current chars-per-second estimate over the sliding window.
    pub(crate) fn rate(&self) -> f64 {
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .rate(Instant::now())
    }
}

/// Sliding window of delta samples: `(timestamp, chars)` per sample; samples
/// older than [RATE_WINDOW] are dropped on push/rate.
#[derive(Default)]
struct RateWindow {
    samples: VecDeque<(Instant, u64)>,
}

impl RateWindow {
    fn clear(&mut self) {
        self.samples.clear();
    }

    fn push(&mut self, chars: u64, now: Instant) {
        self.samples.push_back((now, chars));
        self.trim(now);
    }

    fn trim(&mut self, now: Instant) {
        while let Some((front, _)) = self.samples.front() {
            if now.duration_since(*front) > RATE_WINDOW {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// chars in the window / elapsed span (min 1s so a burst of a few deltas
    /// never reports a silly multi-thousand rate).
    fn rate(&mut self, now: Instant) -> f64 {
        self.trim(now);
        let Some((front, _)) = self.samples.front() else {
            return 0.0;
        };
        let secs = now.duration_since(*front).as_secs_f64().max(1.0);
        let chars: u64 = self.samples.iter().map(|(_, c)| c).sum();
        chars as f64 / secs
    }
}

/// Lightweight W218 statusline view: everything a statusline needs, so the
/// turn task can emit snapshots without a request path.
pub(crate) struct StatusView {
    pub(crate) model: String,
    pub(crate) reasoning_effort: Value,
    pub(crate) status: Arc<StatusTracker>,
    pub(crate) session: Arc<dyn SessionLog>,
    /// W225: live profile context window (0 = trimming off -> display default).
    pub(crate) context_window: u64,
}

/// W225: one engine generation — the hot-swappable unit behind /api/config.
/// Every field derives from the same Profile, so readers never observe a
/// mixed state (model from one compose, session from another).
pub(crate) struct Gen {
    pub(crate) runtime: Arc<Runtime>,
    pub(crate) profile: Profile,
    pub(crate) model: String,
    pub(crate) base_url: String,
    /// profile reasoning_effort serialized (null | "low" | "medium" | "high").
    pub(crate) reasoning_effort: Value,
    /// Sanitized config JSON (GET/POST /api/config response body).
    pub(crate) config_json: Value,
}

/// W225: compose one engine generation from a profile. With
/// CELESTEA_SESSION_DIR set the engine replays <dir>/cli-main.jsonl into the
/// new Runtime, so the host conversation survives the swap.
pub(crate) fn build_gen(profile: Profile) -> Result<Gen, String> {
    let runtime = Runtime::compose(&profile).map_err(|e| format!("{e:#}"))?;
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );
    Ok(Gen {
        runtime: Arc::new(runtime),
        model: profile.model.clone(),
        base_url: base_url.clone(),
        reasoning_effort: serde_json::to_value(profile.reasoning_effort).unwrap_or(Value::Null),
        config_json: sanitized_config(&profile, &base_url),
        profile,
    })
}

/// W236 shared recompose tail for hot swaps (post_config / providers default):
/// merge a profile JSON, inject an api key through the process env (the
/// engine's only key channel — in-memory only, never logged), then compose a
/// fresh generation. Env injection happens before compose so the new adapter
/// reads the new key.
pub(crate) fn prepare_gen(pj: Value, api_key: Option<&str>) -> Result<Gen, String> {
    let new_profile = merge_profile(&pj).map_err(|e| e.to_string())?;
    if let Some(k) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        std::env::set_var(new_profile.api_key_env.as_str(), k);
    }
    build_gen(new_profile).map_err(|e| format!("compose failed: {e}"))
}

/// W236: swap a prepared generation under the gen write lock; returns the
/// new sanitized config JSON.
pub(crate) fn swap_gen(st: &Shared, gen: Gen) -> Value {
    let response = gen.config_json.clone();
    *st.gen.write().unwrap_or_else(|p| p.into_inner()) = gen;
    response
}

/// W236: prepare + swap in one step (the post_config tail).
pub(crate) fn build_and_swap(
    st: &Shared,
    pj: Value,
    api_key: Option<&str>,
) -> Result<Value, String> {
    let gen = prepare_gen(pj, api_key)?;
    Ok(swap_gen(st, gen))
}

pub(crate) struct AppState {
    /// W225: current engine generation (hot-swapped by POST /api/config).
    pub(crate) gen: RwLock<Gen>,
    pub(crate) bcast: broadcast::Sender<BusEvent>,
    /// Active turn's cancel sender (single concurrent turn for the MVP).
    pub(crate) busy: Arc<Mutex<Option<watch::Sender<bool>>>>,
    pub(crate) next_turn: Arc<AtomicU64>,
    pub(crate) seq: Arc<AtomicU64>,
    /// W218: shared statusline tracker (steps / token rate), fed by the turn
    /// sink and read by SSE status payloads + GET /api/status.
    pub(crate) status: Arc<StatusTracker>,
    /// W236: model providers store (providers.json; api keys live here and
    /// are never serialized into any response or log line).
    pub(crate) providers: Arc<crate::providers::ProvidersStore>,
    /// W237: workspace registry (workspaces.json; the active session id is
    /// persisted here and drives CELESTEA_SESSION_DIR at boot/activation).
    pub(crate) workspaces: Arc<crate::workspaces::WorkspaceRegistry>,
}

impl AppState {
    /// W218: snapshot view for statusline computation (turn task / API).
    pub(crate) fn status_view(&self) -> StatusView {
        let gen = self.gen.read().unwrap_or_else(|p| p.into_inner());
        StatusView {
            model: gen.model.clone(),
            reasoning_effort: gen.reasoning_effort.clone(),
            status: self.status.clone(),
            session: gen.runtime.session.clone(),
            context_window: gen.profile.context_window_tokens,
        }
    }

    /// W218: current statusline JSON (SSE status payloads + GET /api/status).
    pub(crate) fn statusline(&self) -> Value {
        statusline_of(&self.status_view())
    }
}

pub(crate) type Shared = Arc<AppState>;

/// W218: build the statusline JSON: {model, reasoning_effort, steps,
/// tokens_per_sec, context_usage}. `steps` is counted from tool/tool_result
/// events; `tokens_per_sec` from text/thinking delta rate; `context_usage` is
/// an estimate from the session log (event character volume vs the fixed 1M
/// window) because the engine's streaming path does not surface LLM usage
/// frames — the response marks the estimate (`estimated:true`).
pub(crate) fn statusline_of(view: &StatusView) -> Value {
    let used = estimated_context_chars(&view.session.events());
    // W225: live profile window (0 = trimming off -> contract display default).
    let window = if view.context_window > 0 {
        view.context_window
    } else {
        CONTEXT_WINDOW
    };
    let ratio = (used as f64 / window as f64 * 10_000.0).round() / 10_000.0;
    json!({
        "model": view.model,
        "reasoning_effort": view.reasoning_effort,
        "steps": view.status.steps.load(Ordering::Relaxed),
        "tokens_per_sec": (view.status.rate() * 100.0).round() / 100.0,
        "context_usage": {
            "used": used,
            "window": window,
            "ratio": ratio.min(1.0),
            "estimated": true,
            "method": "session_event_chars",
        },
    })
}

/// W218 context-usage estimate: total character volume of the session log
/// (user/assistant text + tool call args + tool results/errors).
fn estimated_context_chars(events: &[SessionEvent]) -> u64 {
    let mut total = 0u64;
    for ev in events {
        match ev {
            SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => {}
            SessionEvent::UserMessage { text } => total += text.chars().count() as u64,
            SessionEvent::AssistantMessage { text } => total += text.chars().count() as u64,
            SessionEvent::ToolCall { id, name, args } => {
                total += id.chars().count() as u64;
                total += name.chars().count() as u64;
                total += args.to_string().chars().count() as u64;
            }
            SessionEvent::ToolResult { id, value, error } => {
                total += id.chars().count() as u64;
                if let Some(v) = value {
                    total += v.to_string().chars().count() as u64;
                }
                if let Some(e) = error {
                    total += e.chars().count() as u64;
                }
            }
        }
    }
    total
}

#[derive(Deserialize)]
struct TurnReq {
    input: String,
}
fn emit(
    bcast: &broadcast::Sender<BusEvent>,
    seq: &AtomicU64,
    turn: u64,
    kind: &'static str,
    payload: Value,
) {
    let _ = bcast.send(BusEvent {
        kind,
        data: json!({
            "turn": turn,
            "seq": seq.fetch_add(1, Ordering::Relaxed),
            "payload": payload,
        }),
    });
}

fn to_sse(ev: &BusEvent) -> Event {
    Event::default().event(ev.kind).data(ev.data.to_string())
}

/// Map one engine LoopEvent to (SSE event name, payload).
fn loop_event_to_json(ev: LoopEvent) -> (&'static str, Value) {
    match ev {
        LoopEvent::Text(t) => ("text", json!({"delta": t})),
        LoopEvent::Thinking(t) => ("thinking", json!({"delta": t})),
        LoopEvent::ToolCall { id, name, args } => {
            ("tool", json!({"id": id, "name": name, "args": args}))
        }
        LoopEvent::ToolResult(o) => {
            let decision = match &o.decision {
                Some(ToolDecision::Allow) => Some("allow"),
                Some(ToolDecision::Deny(_)) => Some("deny"),
                Some(ToolDecision::Ask(_)) => Some("ask"),
                None => None,
            };
            (
                "tool_result",
                json!({
                    "id": o.call_id,
                    "ok": o.error.is_none(),
                    "value": o.value,
                    "render": o.render,
                    "error": o.error,
                    "decision": decision,
                }),
            )
        }
        LoopEvent::Done(m) => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for c in &m.content {
                match c {
                    Content::Text(t) => text.push_str(t),
                    Content::ToolCall(tc) => tool_calls.push(json!({
                        "id": tc.id,
                        "name": tc.name,
                        "args": tc.args,
                    })),
                }
            }
            ("done", json!({"text": text, "tool_calls": tool_calls}))
        }
    }
}

// ---- static handlers -------------------------------------------------------

/// W218: serve the frontend build (frontend/dist/) for the UI and every
/// root-level asset the Vite build emits (index.html, assets/*.js|css,
/// favicon, ...); unknown non-API paths fall back to the SPA index
/// (Vite history-mode). When dist/ is absent the index shows the
/// "build the frontend first" hint page instead.
async fn get_static(OriginalUri(uri): OriginalUri) -> Response {
    let path = uri.path();
    // keep 404 semantics for unknown API paths (this handler is the fallback)
    if path.starts_with("/api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not found"})),
        )
            .into_response();
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let Some(rel) = sanitize_rel(rel) else {
        return not_found_response();
    };
    let base = Path::new(STATIC_ROOT);
    match tokio::fs::read(base.join(&rel)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_for(&rel)),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        // Missing extensionless path = SPA route: index.html when the build
        // exists, otherwise the build hint.
        Err(_) if rel == "index.html" || !rel.contains('.') => {
            match tokio::fs::read(base.join("index.html")).await {
                Ok(bytes) => (
                    [
                        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    bytes,
                )
                    .into_response(),
                Err(_) => hint_response(),
            }
        }
        Err(_) => not_found_response(),
    }
}

/// Harden a request-relative path: allow normal components only, reject
/// `..` / absolute / prefix components.
fn sanitize_rel(rel: &str) -> Option<String> {
    let mut out = String::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => {
                if !out.is_empty() {
                    out.push('/');
                }
                out.push_str(c.to_str()?);
            }
            Component::CurDir => {}
            Component::ParentDir => return None,
            _ => return None,
        }
    }
    Some(out)
}

fn mime_for(rel: &str) -> &'static str {
    match Path::new(rel).extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// W218: index placeholder when frontend/dist/ is absent (frontend not built).
fn hint_response() -> Response {
    const HINT: &str = concat!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<title>Celestea-Studio</title>",
        "<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8eaf0;",
        "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}",
        ".box{max-width:34rem;padding:2rem;border:1px solid #2a3040;border-radius:12px;line-height:1.7}",
        "code{background:#1a2030;padding:.15rem .4rem;border-radius:6px}</style></head><body>",
        "<div class=\"box\"><h2>先构建前端</h2>",
        "<p>Celestea-Studio 前端尚未构建：<code>frontend/dist/</code> 不存在（或缺少 <code>index.html</code>）。</p>",
        "<p>在 <code>/src/celestea_studio/frontend</code> 执行 ",
        "<code>npm install &amp;&amp; npm run build</code> 生成 Vite 产物到 ",
        "<code>frontend/dist/</code> 后刷新本页即可；API 端点照常可用。</p>",
        "</div></body></html>"
    );
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        HINT,
    )
        .into_response()
}

fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "not found",
    )
        .into_response()
}

// ---- handlers -------------------------------------------------------------

async fn get_health(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    Json(json!({
        "ok": true,
        "name": "celestea-studio",
        "model": gen.model,
        "base_url": gen.base_url,
        "bind": DEFAULT_BIND,
    }))
}

async fn get_events(
    State(st): State<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = st.bcast.subscribe();
    let st_for_lag = st.clone();
    // tokio-stream's filter_map is sync: a lagged client gets a resync
    // status event and the stream keeps flowing (EventSource auto-reconnects
    // anyway if it drops).
    let stream = BroadcastStream::new(rx).filter_map(move |item| {
        let st = st_for_lag.clone();
        match item {
            Ok(ev) => Some(Ok::<_, Infallible>(to_sse(&ev))),
            Err(_) => Some(Ok(Event::default()
                .event("status")
                .data(
                    json!({
                        "phase": "lagged",
                        "hint": "slow client, skipped events",
                        "statusline": st.statusline(),
                    })
                    .to_string(),
                ))),
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn post_turn(State(st): State<Shared>, Json(req): Json<TurnReq>) -> impl IntoResponse {
    let input = req.input.trim().to_string();
    if input.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "input must not be empty"})),
        );
    }
    let mut busy = st.busy.lock().await;
    if busy.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": "a turn is already running"})),
        );
    }
    let (cancel_tx, cancel_rx) = watch::channel(false);
    *busy = Some(cancel_tx);
    drop(busy);

    // W218: new-turn statusline baseline (steps=0, empty rate window).
    st.status.reset();
    let turn = st.next_turn.fetch_add(1, Ordering::Relaxed);
    emit(
        &st.bcast,
        &st.seq,
        turn,
        "status",
        json!({"phase": "start", "statusline": st.statusline()}),
    );

    let runtime = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.runtime.clone()
    };
    let bcast = st.bcast.clone();
    let seq = st.seq.clone();
    let busy_slot = st.busy.clone();
    let tracker = st.status.clone();
    let view = st.status_view();
    tokio::spawn(async move {
        // Turn sink: feed the statusline tracker (steps from tool /
        // tool_result, delta chars for tokens_per_sec) and forward every
        // event to the SSE bus.
        let sink: EventSink = {
            let sink_bcast = bcast.clone();
            let sink_seq = seq.clone();
            let tracker = tracker.clone();
            Arc::new(move |ev: LoopEvent| {
                match &ev {
                    LoopEvent::Text(t) => tracker.add_chars(t.chars().count() as u64),
                    LoopEvent::Thinking(t) => tracker.add_chars(t.chars().count() as u64),
                    LoopEvent::ToolCall { .. } | LoopEvent::ToolResult(_) => tracker.add_step(),
                    LoopEvent::Done(_) => {}
                }
                let (kind, payload) = loop_event_to_json(ev);
                let _ = sink_bcast.send(BusEvent {
                    kind,
                    data: json!({
                        "turn": turn,
                        "seq": sink_seq.fetch_add(1, Ordering::Relaxed),
                        "payload": payload,
                    }),
                });
            })
        };

        // Drive the turn; every STATUS_TICK emit a "progress" status event
        // carrying the live statusline (SSE incremental channel).
        let mut ticker = tokio::time::interval(STATUS_TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // consume the immediate first tick
        let run = runtime.run_turn(&input, Some(cancel_rx), Some(sink));
        tokio::pin!(run);
        let outcome = loop {
            tokio::select! {
                out = &mut run => break out,
                _ = ticker.tick() => {
                    emit(&bcast, &seq, turn, "status", json!({
                        "phase": "progress",
                        "statusline": statusline_of(&view),
                    }));
                }
            }
        };
        let (phase, error) = match outcome {
            Ok(TurnOutcome::Completed) => ("completed", None),
            Ok(TurnOutcome::Cancelled) => ("cancelled", None),
            Err(e) => ("error", Some(e.to_string())),
        };
        let mut final_payload = json!({
            "phase": phase,
            "statusline": statusline_of(&view),
        });
        if let Some(e) = error {
            final_payload["error"] = json!(e);
        }
        emit(&bcast, &seq, turn, "status", final_payload);

        let mut busy_slot = busy_slot.lock().await;
        *busy_slot = None;
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({"turn": turn, "status": "started"})),
    )
}
async fn post_cancel(State(st): State<Shared>) -> Json<Value> {
    let busy = st.busy.lock().await;
    match busy.as_ref() {
        Some(tx) => {
            let _ = tx.send(true);
            Json(json!({"ok": true, "cancelled": true}))
        }
        None => Json(json!({"ok": true, "cancelled": false})),
    }
}

// ---- main -----------------------------------------------------------------

#[tokio::main]
async fn main() {
    load_dotenv();
    // W237: workspace registry. workspaces.json lives next to the binary's
    // cwd (CELESTEA_WORKSPACES_FILE overrides it for smoke instances); when
    // it is missing the legacy flat sessions/ layout is migrated into
    // per-session directories and the default workspace (默认 ->
    // <cwd>/sessions, active "默认/cli-main") is registered.
    let registry_path = std::env::var("CELESTEA_WORKSPACES_FILE")
        .ok()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("workspaces.json"));
    let sessions_root = std::env::current_dir()
        .map(|cwd| cwd.join("sessions"))
        .unwrap_or_else(|_| PathBuf::from("sessions"));
    let registry = Arc::new(match crate::workspaces::load_registry(registry_path, &sessions_root) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[celestea-studio] workspaces registry error: {e}");
            std::process::exit(1);
        }
    });
    // W237: restore the persisted active session BEFORE the first compose —
    // CELESTEA_SESSION_DIR names the session DIRECTORY and the engine
    // replays <dir>/cli-main.jsonl through PersistentSessionLog. A dangling
    // id falls back to the first registered workspace's cli-main session.
    let mut active_id = registry.active_session();
    let mut active_dir = active_id.as_deref().and_then(|id| {
        crate::workspaces::resolve_session_dir(&registry.snapshot(), id)
            .ok()
            .map(|r| r.2)
            .filter(|d| d.parent().is_some_and(|p| p.is_dir()))
    });
    if active_dir.is_none() {
        if let Some(ws) = registry.snapshot().workspaces.first() {
            let dir = Path::new(&ws.path).join("cli-main");
            let id = format!("{}/cli-main", ws.name);
            eprintln!(
                "[celestea-studio] active session '{:?}' unusable; falling back to workspace '{}' session 'cli-main'",
                active_id, ws.name,
            );
            if registry.set_active(Some(id.clone())).is_ok() {
                active_id = Some(id);
                active_dir = Some(dir);
            }
        }
    }
    match &active_dir {
        Some(dir) => {
            std::env::set_var("CELESTEA_SESSION_DIR", dir);
            eprintln!(
                "[celestea-studio] active session {} -> {}",
                active_id.as_deref().unwrap_or("?"),
                dir.display()
            );
        }
        None => {
            std::env::remove_var("CELESTEA_SESSION_DIR");
            eprintln!("[celestea-studio] no workspace registered; engine session is in-memory");
        }
    }
    let mut profile = match resolve_profile(
        None,
        false,
        Path::new(PRIMARY_CONFIG),
        Path::new(LEGACY_CONFIG),
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[celestea-studio] profile error: {e:#}");
            std::process::exit(1);
        }
    };
    // W218: remove the step limit. The agent loop runs _step over
    // 0..max_steps, so max_steps=0 means *zero* steps (not unlimited);
    // "no limit" is expressed as a high floor (4096). A config may only
    // raise the cap, never lower it below MIN_STEPS.
    profile.max_steps = profile.max_steps.max(MIN_STEPS);

    // W236: model providers store. providers.json carries api_key plaintext
    // (contract), so the file is 0600 + gitignored; CELESTEA_PROVIDERS_FILE
    // overrides the path (smoke instances). Loading it here — before the
    // first compose — lets a persisted default_model override the
    // celestea.toml model at startup.
    let providers_path = std::env::var("CELESTEA_PROVIDERS_FILE")
        .ok()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("providers.json"));
    let providers = Arc::new(match crate::providers::ProvidersStore::open(providers_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[celestea-studio] providers error: {e}");
            std::process::exit(1);
        }
    });
    if let Some(dm) = crate::providers::apply_startup_default(&providers, &mut profile) {
        eprintln!(
            "[celestea-studio] providers.json default_model '{dm}' overrides celestea.toml (applied before compose)"
        );
    }
    let model = profile.model.clone();
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );
    let gen = match build_gen(profile) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[celestea-studio] compose error: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        gen: RwLock::new(gen),
        bcast: broadcast::channel(512).0,
        busy: Arc::new(Mutex::new(None)),
        next_turn: Arc::new(AtomicU64::new(1)),
        seq: Arc::new(AtomicU64::new(0)),
        status: StatusTracker::new(),
        providers,
        workspaces: registry,
    });

    let app = Router::new()
        .route("/", get(get_static))
        .route("/index.html", get(get_static))
        .route("/assets/{*path}", get(get_static))
        .route("/favicon.ico", get(get_static))
        .route("/api/health", get(get_health))
        .route("/api/status", get(api::get_status))
        .route("/api/events", get(get_events))
        .route("/api/turn", post(post_turn))
        .route("/api/cancel", post(post_cancel))
        .route("/api/tools", get(api::get_tools))
        .route("/api/config", get(api::get_config).post(api::post_config))
        .route("/api/sessions", get(workspaces::get_sessions).post(workspaces::post_session_create))
        // W236/W237: session ids contain a slash ("<workspace>/<session>");
        // clients pass them percent-encoded (the W227 frontend uses
        // encodeURIComponent), which axum decodes back into the segment value.
        .route("/api/sessions/{id}/messages", get(workspaces::get_session_messages))
        .route("/api/sessions/{id}/activate", post(workspaces::post_session_activate))
        .route("/api/sessions/{id}/archive", post(workspaces::post_session_archive))
        .route("/api/sessions/{id}/unarchive", post(workspaces::post_session_unarchive))
        .route("/api/sessions/batch-archive", post(workspaces::post_sessions_batch_archive))
        .route("/api/sessions/batch-delete", post(workspaces::post_sessions_batch_delete))
        .route("/api/workspaces", get(workspaces::get_workspaces).post(workspaces::post_workspace_create))
        .route("/api/workspaces/{name}/delete", post(workspaces::post_workspace_delete))
        .route("/api/workspaces/batch-delete", post(workspaces::post_workspaces_batch_delete))
        .route("/api/fs/browse", get(workspaces::get_fs_browse))
        .route("/api/providers", get(providers::get_providers).post(providers::post_providers))
        .route("/api/providers/{id}/delete", post(providers::post_provider_delete))
        .route("/api/providers/test", post(providers::post_provider_test))
        .route("/api/providers/{id}/models/fetch", post(providers::post_models_fetch))
        .route("/api/providers/default", post(providers::post_provider_default))
        .route("/api/clear", post(workspaces::post_clear))
        .route("/api/worker/spawn", post(api::post_worker_spawn))
        .route("/api/worker/send", post(api::post_worker_send))
        .route("/api/worker/status", get(api::get_worker_status))
        .fallback(get_static)
        .with_state(state);

    let bind = std::env::var("STUDIO_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[celestea-studio] bind {bind} failed: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "[celestea-studio] listening on http://{bind}  (model={model}, base_url={base_url})"
    );
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[celestea-studio] server error: {e}");
        std::process::exit(1);
    }
}

