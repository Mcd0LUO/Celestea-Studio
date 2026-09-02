//! Additional HTTP API surface (W216): expose the full engine capability over
//! the existing turn/SSE endpoints — tool surface, sanitized config, session
//! list/clear, and the three worker-orchestration endpoints.
//!
//! New routes (all mounted on the same axum router in main):
//!   GET  /api/tools             -> {"tools":[{"name","description"}]}
//!   GET  /api/config            -> sanitized Profile (never exposes api_key)
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
use serde::Deserialize;
use serde_json::{json, Value};

use crate::Shared;

// ---- GET /api/tools --------------------------------------------------------

/// Engine tool surface: name + description for every registered tool.
pub async fn get_tools(State(st): State<Shared>) -> Json<Value> {
    let tools: Vec<Value> = st
        .runtime
        .registry
        .schemas()
        .into_iter()
        .map(|s| json!({"name": s.name, "description": s.description}))
        .collect();
    Json(json!({"tools": tools}))
}

// ---- GET /api/config -------------------------------------------------------

/// Sanitized profile JSON (pre-computed at startup; no api_key / api_key_file).
pub async fn get_config(State(st): State<Shared>) -> Json<Value> {
    Json(st.config_json.clone())
}

// ---- GET /api/sessions -----------------------------------------------------

/// Session list: worker sessions from the SessionRegistry, the host
/// conversation driven by /api/turn, and (when CELESTEA_SESSION_DIR is set)
/// every persisted *.jsonl session file in that directory.
pub async fn get_sessions(State(st): State<Shared>) -> Json<Value> {
    let mut sessions: Vec<Value> = Vec::new();

    // 1. Worker sessions (spawned via /api/worker/spawn or the engine tools).
    for meta in st.runtime.workers.sessions().list() {
        let events = st
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
        "model": st.model,
        "kind": "host",
        "events": st.runtime.session.events().len(),
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
    st.runtime.session.clear();
    Json(json!({"ok": true, "cleared": true}))
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
    let out = st
        .runtime
        .registry
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
    let mut summary = st.runtime.workers.summarize(None);
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

