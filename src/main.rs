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
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
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
    load_dotenv, resolve_base_url, resolve_profile, EventSink, LoopEvent, Runtime,
    SessionEvent, SessionLog, TurnOutcome,
};
mod api;

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
}

pub(crate) struct AppState {
    pub(crate) runtime: Arc<Runtime>,
    pub(crate) bcast: broadcast::Sender<BusEvent>,
    /// Active turn's cancel sender (single concurrent turn for the MVP).
    pub(crate) busy: Arc<Mutex<Option<watch::Sender<bool>>>>,
    pub(crate) next_turn: Arc<AtomicU64>,
    pub(crate) seq: Arc<AtomicU64>,
    pub(crate) model: String,
    pub(crate) base_url: String,
    /// Sanitized profile JSON for GET /api/config (never carries the api key).
    pub(crate) config_json: Value,
    /// W218: profile reasoning_effort as JSON (null | "low" | "medium" | "high").
    pub(crate) reasoning_effort: Value,
    /// W218: shared statusline tracker (steps / token rate), fed by the turn
    /// sink and read by SSE status payloads + GET /api/status.
    pub(crate) status: Arc<StatusTracker>,
}

impl AppState {
    /// W218: snapshot view for statusline computation (turn task / API).
    pub(crate) fn status_view(&self) -> StatusView {
        StatusView {
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            status: self.status.clone(),
            session: self.runtime.session.clone(),
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
    let ratio = (used as f64 / CONTEXT_WINDOW as f64 * 10_000.0).round() / 10_000.0;
    json!({
        "model": view.model,
        "reasoning_effort": view.reasoning_effort,
        "steps": view.status.steps.load(Ordering::Relaxed),
        "tokens_per_sec": (view.status.rate() * 100.0).round() / 100.0,
        "context_usage": {
            "used": used,
            "window": CONTEXT_WINDOW,
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
    Json(json!({
        "ok": true,
        "name": "celestea-studio",
        "model": st.model,
        "base_url": st.base_url,
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
            Json(json!({"error": "a turn is already running"})),
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

    let runtime = st.runtime.clone();
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
    // W218: remove the step limit. The agent loop runs `for _step in
    // 0..max_steps`, so max_steps=0 means *zero* steps (not unlimited);
    // "no limit" is expressed as a high floor (4096). A config may only
    // raise the cap, never lower it below MIN_STEPS.
    profile.max_steps = profile.max_steps.max(MIN_STEPS);
    let model = profile.model.clone();
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );
    let runtime = match Runtime::compose(&profile) {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[celestea-studio] compose error: {e:#}");
            std::process::exit(1);
        }
    };

    // Sanitized profile for GET /api/config: every engine-relevant field,
    // never api_key / api_key_file / the resolved key value itself.
    let config_json = json!({
        "model": profile.model.clone(),
        "base_url": base_url.clone(),
        "max_steps": profile.max_steps,
        "max_parallel_tool_calls": profile.max_parallel_tool_calls,
        "reasoning_effort": serde_json::to_value(profile.reasoning_effort)
            .unwrap_or(Value::Null),
        "max_output_tokens": profile.max_output_tokens,
        "system_prompt": profile.system_prompt.clone(),
    });

    let state = Arc::new(AppState {
        runtime: Arc::new(runtime),
        bcast: broadcast::channel(512).0,
        busy: Arc::new(Mutex::new(None)),
        next_turn: Arc::new(AtomicU64::new(1)),
        seq: Arc::new(AtomicU64::new(0)),
        model: model.clone(),
        base_url: base_url.clone(),
        config_json,
        reasoning_effort: serde_json::to_value(profile.reasoning_effort)
            .unwrap_or(Value::Null),
        status: StatusTracker::new(),
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
        .route("/api/config", get(api::get_config))
        .route("/api/sessions", get(api::get_sessions))
        .route("/api/clear", post(api::post_clear))
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

