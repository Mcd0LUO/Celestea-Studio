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

use std::time::UNIX_EPOCH;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use celestea_core::{SessionLog, ToolInput};
use celestea_runtime::{merge_profile, validate_model};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    build_gen, model_reasoning, profile_to_json, DEFAULT_SYSTEM_PROMPT, MIN_STEPS,
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
pub async fn get_sessions(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let mut sessions: Vec<Value> = Vec::new();

    // 1. Worker sessions (spawned via /api/worker/spawn or the engine tools).
    for meta in gen.runtime.workers.sessions().list() {
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
    if let Some(dir) = &sess_dir {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(stem) = name.strip_suffix(".jsonl") else {
                    continue;
                };
                if stem == "cli-main" {
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
                sessions.push(json!({
                    "id": stem,
                    "title": stem,
                    "kind": "persistent",
                    "file": format!("{dir}/{name}"),
                    "size": size,
                    "modified": modified,
                }));
            }
        }
    }

    Json(json!({"sessions": sessions}))
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
    let new_profile = match merge_profile(&pj) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"ok": false, "error": e.to_string()})),
            )
        }
    };
    if let Some(k) = req.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        // in-memory only: the engine reads the key from env[api_key_env] at
        // compose time; the value lives in this process env / the LLM
        // adapter, never on disk and never in a log line.
        std::env::set_var(new_profile.api_key_env.as_str(), k);
    }

    let new_gen = match build_gen(new_profile) {
        Ok(g) => g,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"ok": false, "error": format!("compose failed: {e}")})),
            )
        }
    };
    let response = new_gen.config_json.clone();
    *st.gen.write().unwrap_or_else(|p| p.into_inner()) = new_gen;
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

