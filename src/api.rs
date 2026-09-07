//! Additional HTTP API surface (W216): expose the full engine capability over
//! the existing turn/SSE endpoints — tool surface, sanitized config, session
//! list/clear, and the three worker-orchestration endpoints.
//!
//! New routes (all mounted on the same axum router in main):
//!   GET  /api/tools             -> {"tools":[{"name","description"}]}
//!   GET  /api/config            -> sanitized Profile + available models/efforts
//!   POST /api/config            -> partial hot-reload update (W225; response = new config)
//!   GET  /api/status            -> statusline snapshot (W218: model /
//!                                  reasoning_effort / steps / tokens_per_sec /
//!                                  context_usage; SSE fallback channel)
//!   GET  /api/sessions          -> {"sessions":[...]}
//!   POST /api/clear             -> {"ok":true,"cleared":true}
//!   POST /api/worker/spawn      -> {"ok","sessionId","title","wid"}
//!   POST /api/worker/send       -> {"ok","delivered",...}
//!   GET  /api/worker/status     -> {"ok","total","by_status","workers":[...]}
//!
//! Worker endpoints reuse the engine worker tools (spawn_worker /
//! session_send_message) via the composed ToolRegistry, so the HTTP surface
//! can never drift from the agent tool face; worker_status is built from the
//! shared WorkerRegistry with the protocol's unified aggregate shape.

use std::path::Path as FsPath;
use std::time::UNIX_EPOCH;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use celestea_core::{SessionLog, ToolInput};
use celestea_runtime::{validate_model, SessionEvent};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    build_and_swap, model_reasoning, profile_to_json, DEFAULT_SYSTEM_PROMPT, MIN_STEPS,
    Shared,
};

// ---- GET /api/tools --------------------------------------------------------

/// Engine tool surface: name + description for every registered tool.
pub async fn get_tools(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let tools: Vec<Value> = gen
        .runtime
        .registry
        .schemas()
        .into_iter()
        .map(|s| json!({"name": s.name, "description": s.description}))
        .collect();
    Json(json!({"tools": tools}))
}

// ---- GET /api/config -------------------------------------------------------

/// Sanitized config JSON of the current engine generation + the deployment
/// catalog (available.models / available.efforts). Never carries an api key.
pub async fn get_config(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    Json(gen.config_json.clone())
}

// ---- GET /api/status --------------------------------------------------------

/// W218 statusline snapshot — the fallback channel for the SSE status
/// payloads: {model, reasoning_effort, steps, tokens_per_sec, context_usage}.
/// The same shape rides the SSE status events (start / progress / completed /
/// cancelled / error / lagged); a client that missed (or reconnects to) the
/// stream reads the current values here.
pub async fn get_status(State(st): State<Shared>) -> Json<Value> {
    Json(st.statusline())
}

// ---- GET /api/sessions -----------------------------------------------------

/// Session list: worker sessions from the SessionRegistry, the host
/// conversation driven by /api/turn, and (when CELESTEA_SESSION_DIR is set)
/// every persisted *.jsonl session file in that directory.
///
/// W236 id rule: top-level files keep id "<stem>" with workspace "root";
/// files inside a direct subdirectory get id "<workspace>/<stem>" with
/// workspace = the subdirectory name. cli-main stays the host entry with
/// workspace=null; .trash / .archived are never scanned.
pub async fn get_sessions(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let mut sessions: Vec<Value> = Vec::new();

    // 1. Worker sessions (spawned via /api/worker/spawn or the engine tools).
    //    The host conversation is registered in the same SessionRegistry as
    //    cli-main for receipt routing (W232) — skip it here, it is listed as
    //    the host entry below.
    for meta in gen.runtime.workers.sessions().list() {
        if meta.id == "cli-main" {
            continue;
        }
        let events = gen
            .runtime
            .workers
            .sessions()
            .get(&meta.id)
            .map(|s| s.log.events().len())
            .unwrap_or(0);
        sessions.push(json!({
            "id": meta.id,
            "title": meta.title,
            "workspace": meta.workspace,
            "model": meta.model,
            "kind": "worker",
            "events": events,
        }));
    }

    // 2. Host conversation (driven by POST /api/turn; "cli-main" is the engine's
    //    persistent session id when CELESTEA_SESSION_DIR is set).
    let sess_dir = std::env::var("CELESTEA_SESSION_DIR")
        .ok()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let host_file: Value = match &sess_dir {
        Some(d) => Value::String(format!("{d}/cli-main.jsonl")),
        None => Value::Null,
    };
    sessions.push(json!({
        "id": "cli-main",
        "title": "main",
        "workspace": Value::Null,
        "model": gen.model,
        "kind": "host",
        "events": gen.runtime.session.events().len(),
        "persistent": sess_dir.is_some(),
        "file": host_file,
    }));

    // 3. Persisted session files (other sessions sharing CELESTEA_SESSION_DIR).
    //    W236: scan the session dir by workspace — the top level is workspace
    //    "root", every direct subdirectory (except the reserved .trash /
    //    .archived) is its own workspace.
    if let Some(dir) = &sess_dir {
        let dirp = FsPath::new(dir);
        push_persistent_sessions(dirp, None, &mut sessions);
        let mut subs: Vec<String> = match std::fs::read_dir(dirp) {
            Ok(rd) => rd
                .flatten()
                .filter_map(|e| {
                    let ft = e.file_type().ok()?;
                    if !ft.is_dir() {
                        return None;
                    }
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name == crate::workspaces::TRASH_DIR
                        || name == crate::workspaces::ARCHIVED_DIR
                    {
                        return None;
                    }
                    Some(name)
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        subs.sort();
        for ws in subs {
            push_persistent_sessions(&dirp.join(&ws), Some(&ws), &mut sessions);
        }
    }

    Json(json!({"sessions": sessions}))
}

/// W236: append every *.jsonl file directly inside `dir` as a persistent
/// session entry. ws=None -> workspace "root" and id "<stem>"; ws=Some(name)
/// -> workspace = name and id "<name>/<stem>". cli-main is only skipped at
/// the root (the host entry above owns it).
fn push_persistent_sessions(dir: &FsPath, ws: Option<&str>, sessions: &mut Vec<Value>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if ws.is_none() && stem == "cli-main" {
            continue; // host conversation already listed above
        }
        let (size, modified) = entry
            .metadata()
            .map(|m| {
                (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let id = crate::workspaces::session_id(ws, stem);
        sessions.push(json!({
            "id": id,
            "title": stem,
            "kind": "persistent",
            "workspace": ws.map(str::to_string)
                .unwrap_or_else(|| crate::workspaces::ROOT_WORKSPACE.to_string()),
            "file": format!("{}/{}", dir.display(), name),
            "size": size,
            "modified": modified,
        }));
    }
}

// ---- W228: GET /api/sessions/{id}/messages ---------------------------------

/// Session id -> safe JSONL file name, mirroring the engine's persistence
/// mapping (celestea_session::file_name_for): only [A-Za-z0-9._-] survive,
/// everything else becomes '_', empty ids fall back to "session", always
/// ending in .jsonl. Replicated read-only so the studio stays on the
/// celestea-core/runtime surface; identical output means identical lookup.
pub(crate) fn session_file_name(id: &str) -> String {
    // Same predicate as workspaces::sanitize_component: keep CJK/Unicode
    // letters (Chinese UI), drop separators/control/whitespace to '_'.
    // Studio-side resolution is self-consistent (create and lookup share
    // this sanitizer); the engine's file_name_for stays ASCII-only and is
    // only used for the cli-main PersistentSessionLog.
    let mut name: String = id
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\u{7f}'..='\u{9f}' => '_',
            c if c.is_control() || c.is_whitespace() => '_',
            c => c,
        })
        .collect();
    if name.is_empty() {
        name.push_str("session");
    }
    name.push_str(".jsonl");
    name
}

/// Map one SessionEvent to the W228 message contract. TurnStart/TurnEnd are
/// structural markers and are skipped. Tool events become role "tool" with a
/// decision summary as content: ToolCall = `name(args)` (the agent's
/// decision), ToolResult = the JSON value or `Error: {error}` (the outcome).
/// The engine never persists thinking deltas (SessionEvent has no Thinking
/// variant), so "thinking" cannot appear here — assistant text carries the
/// reply.
fn session_event_to_message(ev: &SessionEvent) -> Option<Value> {
    match ev {
        SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => None,
        SessionEvent::UserMessage { text } => {
            Some(json!({"role": "user", "content": text}))
        }
        SessionEvent::AssistantMessage { text } => {
            Some(json!({"role": "assistant", "content": text}))
        }
        SessionEvent::ToolCall { name, args, .. } => {
            Some(json!({"role": "tool", "content": format!("{name}({args})")}))
        }
        SessionEvent::ToolResult { value, error, .. } => {
            let content = match error {
                Some(e) if !e.is_empty() => format!("Error: {e}"),
                _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
            };
            Some(json!({"role": "tool", "content": content}))
        }
    }
}

/// Parse a persistent session JSONL file (engine v1 format: one
/// serde_json-tagged SessionEvent per line). Blank lines are tolerated;
/// parsing stops at the first unparsable record, mirroring the engine's
/// replay semantics (a torn tail is never surfaced).
fn parse_session_jsonl(text: &str) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionEvent>(line) {
            Ok(ev) => events.push(ev),
            Err(_) => break,
        }
    }
    events
}

/// W228 lenient model-name sanity check: at most 128 chars, only
/// [A-Za-z0-9._-:/@] (no whitespace / brackets / control characters). The
/// engine's validate_model only rejects empty names; this blocks frontend
/// garbage values while staying open for custom OpenAI-compatible endpoints.
fn validate_model_name(m: &str) -> Result<(), String> {
    if m.chars().count() > 128 {
        return Err(format!(
            "invalid model name: '{m}' exceeds 128 characters"
        ));
    }
    if let Some(bad) = m.chars().find(|c| {
        c.is_control()
            || c.is_whitespace()
            || !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@'))
    }) {
        return Err(format!(
            "invalid model name '{m}': character {bad:?} is not allowed (only [A-Za-z0-9._-:/@]; no spaces, brackets or control characters)"
        ));
    }
    Ok(())
}

/// GET /api/sessions/{id}/messages — read-only transcript of one session.
/// Sources, in priority order:
///   1. "cli-main"     -> the host conversation (gen.runtime.session);
///   2. worker session -> gen.runtime.workers.sessions().get(id).log;
///   3. persistent     -> <CELESTEA_SESSION_DIR>/<sanitized-id>.jsonl parsed
///                        with the engine's SessionEvent JSONL format.
/// Unknown ids -> 404 {"ok":false,"error":"unknown session"}.
/// Response: {"ok":true,"session":"<id>","messages":[{"role","content"},...]}
pub async fn get_session_messages(
    State(st): State<Shared>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Clone the runtime handle, then release the gen read lock: file IO for
    // the persistent fallback must not run under the generation lock.
    let runtime = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.runtime.clone()
    };

    let events: Vec<SessionEvent> = if id == "cli-main" {
        runtime.session.events()
    } else if let Some(session) = runtime.workers.sessions().get(&id) {
        session.log.events()
    } else {
        // Persistent JSONL fallback, W236 id rule: a bare stem resolves in
        // the session dir root first, a "<workspace>/<stem>" id resolves in
        // that subdirectory. Every segment is sanitized with the engine's
        // file_name_for character set and the resolved path is
        // parent-verified (traversal impossible).
        let Some(dir) = std::env::var("CELESTEA_SESSION_DIR")
            .ok()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
        else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"ok": false, "error": "unknown session"})),
            );
        };
        let Some(path) = crate::workspaces::resolve_session_path(FsPath::new(&dir), &id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"ok": false, "error": "unknown session"})),
            );
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => parse_session_jsonl(&text),
            Err(_) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({"ok": false, "error": "unknown session"})),
                )
            }
        }
    };

    let messages: Vec<Value> = events.iter().filter_map(session_event_to_message).collect();
    (
        StatusCode::OK,
        Json(json!({"ok": true, "session": id, "messages": messages})),
    )
}

// ---- POST /api/clear -------------------------------------------------------

/// Clear the host conversation log (engine SessionLog::clear; truncates the
/// persistent JSONL when CELESTEA_SESSION_DIR is set).
pub async fn post_clear(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    gen.runtime.session.clear();
    Json(json!({"ok": true, "cleared": true}))
}

// ---- POST /api/config -----------------------------------------------------

/// Partial config update — every field is optional; present fields take
/// effect for the NEXT turn. The engine is re-composed from the merged
/// profile (host conversation preserved through PersistentSessionLog /
/// CELESTEA_SESSION_DIR replay), so changes apply without a restart.
/// api_key is forwarded via the process env only: it never touches disk,
/// never appears in logs, and is never echoed (the response is the
/// sanitized config — the GET /api/config body).
#[derive(Deserialize)]
pub struct ConfigReq {
    pub model: Option<String>,
    /// Outer Some = field present; inner null / "off" clears the effort,
    /// low/high/max set it (max = engine high; engine-native "medium" is
    /// accepted for back-compat with celestea.toml).
    pub reasoning_effort: Option<Option<String>>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_output_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub max_steps: Option<u64>,
    pub system_prompt: Option<String>,
}

/// Public effort tier -> engine-level effort name. max == engine High (the
/// ceiling the engine exposes). "" / "off" clears the effort.
fn parse_effort(s: &str) -> Result<Option<&'static str>, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "" | "off" => Ok(None),
        "low" => Ok(Some("low")),
        "medium" => Ok(Some("medium")),
        "high" | "max" => Ok(Some("high")),
        other => Err(format!(
            "invalid reasoning_effort '{other}': expected low|high|max (off clears)"
        )),
    }
}

/// POST /api/config — partial profile update, hot-applied to the next turn:
///   1. refuse while a turn runs (409) — a swap mid-turn could lose events
///      the running runtime appends after the new session log was replayed;
///   2. merge the overrides onto the CURRENT profile (engine lenient merge);
///   3. api_key -> env[api_key_env] in-memory (the engine's only key channel;
///      never persisted, never logged);
///   4. Runtime::compose with the new Profile (same PersistentSessionLog =>
///      session replayed), then swap the generation under the write lock.
/// Response: the sanitized config — same body as GET /api/config.
pub async fn post_config(State(st): State<Shared>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let guard = st.busy.lock().await;
    if guard.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": "turn in progress; config applies between turns"})),
        );
    }

    let (mut pj, current_model) = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        (profile_to_json(&gen.profile), gen.profile.model.clone())
    };

    // ---- validate + apply partial overrides --------------------------------
    let target_model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(m) = target_model.as_deref() {
        if let Err(e) = validate_model(m) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": e.to_string()})),
            );
        }
        // W228: lenient studio-side sanity check on top of the engine's
        // empty-only rule — blocks the garbage the UI settings page once
        // saved (e.g. the literal "[object Object]") from entering the
        // profile / config_json.
        if let Err(e) = validate_model_name(m) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": e})),
            );
        }
        pj["model"] = json!(m);
    }

    let effort: Option<Result<Option<&'static str>, String>> =
        req.reasoning_effort.as_ref().map(|v| match v {
            None => Ok(None), // JSON null -> clear
            Some(s) => parse_effort(s),
        });
    let effort = match effort {
        Some(Err(e)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": e})),
            )
        }
        Some(Ok(v)) => Some(v),
        None => None,
    };
    if let Some(Some(eng)) = effort {
        // efforts are meaningful only on reasoning models: reject the pairing
        // for a KNOWN non-reasoning model (unknown ids on custom endpoints
        // are accepted and treated as reasoning-capable).
        let target = target_model.as_deref().unwrap_or(current_model.as_str());
        if model_reasoning(target) == Some(false) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": format!("model '{target}' is not a reasoning model; reasoning_effort is unavailable")
                })),
            );
        }
        pj["reasoning_effort"] = json!(eng);
    } else if let Some(None) = effort {
        pj.as_object_mut()
            .expect("profile json is an object")
            .remove("reasoning_effort");
    }

    if let Some(b) = req.base_url.as_deref() {
        let b = b.trim();
        if b.is_empty() {
            // clear the base_url override -> env / provider default chain
            pj.as_object_mut()
                .expect("profile json is an object")
                .remove("base_url");
        } else if b.starts_with("http://") || b.starts_with("https://") {
            pj["base_url"] = json!(b);
        } else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "base_url must be an http:// or https:// URL"})),
            );
        }
    }
    if let Some(n) = req.max_output_tokens {
        if n == 0 {
            // 0 clears the cap (no max_output_tokens sent upstream)
            pj.as_object_mut()
                .expect("profile json is an object")
                .remove("max_output_tokens");
        } else if n <= u32::MAX as u64 {
            pj["max_output_tokens"] = json!(n);
        } else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "max_output_tokens must be <= u32::MAX"})),
            );
        }
    }
    if let Some(n) = req.context_window {
        // 0 keeps the engine's ""disable trimming"" semantic (statusline then
        // falls back to the contract display window).
        pj["context_window_tokens"] = json!(n);
    }
    if let Some(n) = req.max_steps {
        if n == 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "max_steps must be >= 1"})),
            );
        }
        // W218 floor still applies: the cap may only be raised, never lowered
        // below MIN_STEPS.
        pj["max_steps"] = json!(n.max(MIN_STEPS as u64));
    }
    if let Some(s) = req.system_prompt.as_deref() {
        let s = s.trim();
        if s.is_empty() {
            pj["system_prompt"] = json!(DEFAULT_SYSTEM_PROMPT);
        } else {
            pj["system_prompt"] = json!(s);
        }
    }

    // ---- apply --------------------------------------------------------------
    // W236: shared merge + env-key-injection + compose + swap tail
    // (main.rs::build_and_swap), also used by the providers default-model
    // hot-apply. The api key stays in the process env only — never on disk,
    // never in a log line, never echoed (the response is the sanitized
    // config).
    let response = match build_and_swap(&st, pj, req.api_key.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"ok": false, "error": e})),
            )
        }
    };
    drop(guard);
    (StatusCode::OK, Json(response))
}

// ---- worker endpoints ------------------------------------------------------

#[derive(Deserialize)]
pub struct SpawnReq {
    pub wid: String,
    pub brief: String,
    pub title: Option<String>,
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub struct SendReq {
    pub target: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pub wid: Option<String>,
}

/// Dispatch one engine worker tool and map the ToolOutput to an HTTP response.
/// The worker tools are contract tools: they return Ok(value) even for
/// contract failures ({ok:false, step, error}), so those ride a 200 with the
/// engine shape; only a hard tool failure maps to a 5xx.
async fn dispatch_worker_tool(
    st: &Shared,
    name: &str,
    args: Value,
) -> (StatusCode, Json<Value>) {
    let registry = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.runtime.registry.clone()
    };
    let out = registry
        .dispatch(ToolInput {
            call_id: format!("w216-{name}"),
            name: name.into(),
            args,
        })
        .await;
    match (out.value, out.error) {
        (Some(v), None) => (StatusCode::OK, Json(v)),
        (None, Some(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"ok": false, "error": e})),
        ),
        (Some(v), Some(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"ok": false, "value": v, "error": e})),
        ),
        (None, None) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "tool returned no value"})),
        ),
    }
}

/// POST /api/worker/spawn {wid,brief,title?,model?} -> {ok,sessionId,title,wid}
pub async fn post_worker_spawn(
    State(st): State<Shared>,
    Json(req): Json<SpawnReq>,
) -> impl IntoResponse {
    let mut args = json!({"wid": req.wid, "brief": req.brief});
    if let Some(t) = req.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args["title"] = Value::String(t.to_string());
    }
    if let Some(m) = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args["model"] = Value::String(m.to_string());
    }
    dispatch_worker_tool(&st, "spawn_worker", args).await
}

/// POST /api/worker/send {target,content} -> {ok,delivered,...}
pub async fn post_worker_send(
    State(st): State<Shared>,
    Json(req): Json<SendReq>,
) -> impl IntoResponse {
    dispatch_worker_tool(
        &st,
        "session_send_message",
        json!({"target": req.target, "content": req.content}),
    )
    .await
}

/// GET /api/worker/status?wid= -> {ok,total,by_status,workers:[...]}
///
/// Without wid the engine aggregate is returned verbatim. With wid the same
/// aggregate shape is kept (protocol) and the list is filtered to that worker;
/// a miss is {ok:false,total:0,workers:[]} with an error string, still 200.
pub async fn get_worker_status(
    State(st): State<Shared>,
    Query(q): Query<StatusQuery>,
) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let mut summary = gen.runtime.workers.summarize(None);
    if let Some(wid) = q.wid.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let (total, running, done, failed) = {
            let workers = summary["workers"]
                .as_array_mut()
                .expect("summarize always yields a workers array");
            workers.retain(|w| w.get("wid").and_then(|v| v.as_str()) == Some(wid));
            let total = workers.len();
            let running = workers.iter().filter(|w| w["status"] == "RUNNING").count();
            let done = workers.iter().filter(|w| w["status"] == "DONE").count();
            let failed = workers.iter().filter(|w| w["status"] == "FAILED").count();
            (total, running, done, failed)
        };
        summary["total"] = json!(total);
        summary["by_status"] = json!({
            "RUNNING": running,
            "DONE": done,
            "FAILED": failed,
        });
        summary["ok"] = json!(total > 0);
        summary["wid"] = json!(wid);
        if total == 0 {
            summary["error"] = json!(format!("no worker {wid} in registry"));
        }
    }
    Json(summary)
}


#[cfg(test)]
mod w228_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_model_name_accepts_catalog_and_custom_names() {
        for ok in [
            "deepseek-v4-flash-vision-exp",
            "deepseek-v4-pro-0813",
            "glm-5.3",
            "muse-spark-1.2-contributor",
            "openai/gpt-5.6-sol",
            "custom:model@tag",
            "a.b-c_d/e@f",
        ] {
            assert!(validate_model_name(ok).is_ok(), "{ok} should pass");
        }
    }

    #[test]
    fn validate_model_name_rejects_garbage() {
        for bad in [
            "[object Object]",
            "deepseek v4 pro",
            "deepseek-v4-pro\t",
            "model\nname",
            "model[0]",
            "模型-中文",
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ] {
            assert!(validate_model_name(bad).is_err(), "{bad:?} should fail");
        }
        // exactly 128 chars is still fine
        let long = "a".repeat(128);
        assert!(validate_model_name(&long).is_ok());
    }

    #[test]
    fn session_file_name_matches_engine_sanitization() {
        assert_eq!(session_file_name("session-0"), "session-0.jsonl");
        assert_eq!(session_file_name("../etc/passwd"), ".._etc_passwd.jsonl"); // "." survives, matching the engine
        assert_eq!(session_file_name(""), "session.jsonl");
        assert_eq!(session_file_name("a b[c]"), "a_b[c].jsonl"); // brackets are legal in file names; CJK kept as well
    }

    #[test]
    fn parse_session_jsonl_tolerates_blank_lines_and_torn_tail() {
        let text = format!(
            "{}\n\n{}\n{{bad json\n",
            serde_json::to_string(&SessionEvent::UserMessage { text: "a".into() }).unwrap(),
            serde_json::to_string(&SessionEvent::AssistantMessage { text: "b".into() }).unwrap(),
        );
        let events = parse_session_jsonl(&text);
        assert_eq!(events.len(), 2);
        // The unparsable tail is dropped, not surfaced.
        let text2 = "{\"type\":\"user_message\",\"tex\"";
        assert_eq!(parse_session_jsonl(text2).len(), 0);
    }

    #[test]
    fn session_event_to_message_maps_all_kinds() {
        let evs = vec![
            SessionEvent::TurnStart { id: "t1".into() },
            SessionEvent::UserMessage { text: "hi".into() },
            SessionEvent::AssistantMessage { text: "hello".into() },
            SessionEvent::ToolCall { id: "c1".into(), name: "read_file".into(), args: json!({"path": "/tmp/x"}) },
            SessionEvent::ToolResult { id: "c1".into(), value: Some(json!({"ok": true})), error: None },
            SessionEvent::ToolResult { id: "c2".into(), value: None, error: Some("boom".into()) },
            SessionEvent::TurnEnd { id: "t1".into() },
        ];
        let msgs: Vec<Value> = evs.iter().filter_map(session_event_to_message).collect();
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[0], json!({"role": "user", "content": "hi"}));
        assert_eq!(msgs[1], json!({"role": "assistant", "content": "hello"}));
        assert_eq!(
            msgs[2],
            json!({"role": "tool", "content": r#"read_file({"path":"/tmp/x"})"#})
        );
        assert_eq!(msgs[3], json!({"role": "tool", "content": r#"{"ok":true}"#}));
        assert_eq!(msgs[4], json!({"role": "tool", "content": "Error: boom"}));
    }
}
