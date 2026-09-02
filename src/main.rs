//! celestea-studio — local web UI over the celestea-runtime engine (W215).
//!
//! One Rust binary: axum HTTP server on 127.0.0.1:3777 that serves the
//! embedded frontend and exposes turn endpoints. POST /api/turn drives one
//! Runtime::run_turn with a per-turn EventSink; every LoopEvent is mapped to
//! an SSE event on GET /api/events.
//!
//! SSE event names (mirroring the engine LoopEvent variants):
//!   - text        {"delta": String}
//!   - thinking    {"delta": String}
//!   - tool        {"id", "name", "args"}
//!   - tool_result {"id", "ok", "value", "render", "error", "decision"}
//!   - done        {"text", "tool_calls": [...]}
//!   - status      {"phase": "start|completed|cancelled|error|lagged", ...}
//! Every SSE event carries {"turn": N, "seq": M, "payload": {...}}.

use std::convert::Infallible;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse};
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
    TurnOutcome,
};
/// Default bind address (loopback only; access via ssh -L tunnel).
const DEFAULT_BIND: &str = "127.0.0.1:3777";
/// Engine default config names, resolved from the process cwd.
const PRIMARY_CONFIG: &str = "celestea.toml";
const LEGACY_CONFIG: &str = "profile.json";

const INDEX_HTML: &str = include_str!("../frontend/index.html");
const APP_JS: &str = include_str!("../frontend/app.js");
const STYLE_CSS: &str = include_str!("../frontend/style.css");

/// One turn-level event on the broadcast bus; kind is the SSE event name.
#[derive(Clone, Debug)]
struct BusEvent {
    kind: &'static str,
    data: Value,
}

struct AppState {
    runtime: Arc<Runtime>,
    bcast: broadcast::Sender<BusEvent>,
    /// Active turn's cancel sender (single concurrent turn for the MVP).
    busy: Arc<Mutex<Option<watch::Sender<bool>>>>,
    next_turn: Arc<AtomicU64>,
    seq: Arc<AtomicU64>,
    model: String,
    base_url: String,
}

type Shared = Arc<AppState>;

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

// ---- handlers -------------------------------------------------------------

async fn get_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn get_app_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        APP_JS,
    )
}

async fn get_style_css() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], STYLE_CSS)
}
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
    // tokio-stream's filter_map is sync: a lagged client gets a resync
    // status event and the stream keeps flowing (EventSource auto-reconnects
    // anyway if it drops).
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(ev) => Some(Ok::<_, Infallible>(to_sse(&ev))),
        Err(_) => Some(Ok(Event::default()
            .event("status")
            .data(json!({"phase": "lagged", "hint": "slow client, skipped events"}).to_string()))),
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

    let turn = st.next_turn.fetch_add(1, Ordering::Relaxed);
    emit(&st.bcast, &st.seq, turn, "status", json!({"phase": "start"}));

    let runtime = st.runtime.clone();
    let bcast = st.bcast.clone();
    let seq = st.seq.clone();
    let busy_slot = st.busy.clone();
    tokio::spawn(async move {
        let sink_bcast = bcast.clone();
        let sink_seq = seq.clone();
        let sink: EventSink = Arc::new(move |ev| {
            let (kind, payload) = loop_event_to_json(ev);
            let _ = sink_bcast.send(BusEvent {
                kind,
                data: json!({
                    "turn": turn,
                    "seq": sink_seq.fetch_add(1, Ordering::Relaxed),
                    "payload": payload,
                }),
            });
        });
        let outcome = runtime.run_turn(&input, Some(cancel_rx), Some(sink)).await;
        let status = match outcome {
            Ok(TurnOutcome::Completed) => json!({"phase": "completed"}),
            Ok(TurnOutcome::Cancelled) => json!({"phase": "cancelled"}),
            Err(e) => json!({"phase": "error", "error": e.to_string()}),
        };
        emit(&bcast, &seq, turn, "status", status);
        let mut busy_slot = busy_slot.lock().await;
        *busy_slot = None;
    });

    (StatusCode::ACCEPTED, Json(json!({"turn": turn, "status": "started"})))
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
    let profile = match resolve_profile(
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

    let state = Arc::new(AppState {
        runtime: Arc::new(runtime),
        bcast: broadcast::channel(512).0,
        busy: Arc::new(Mutex::new(None)),
        next_turn: Arc::new(AtomicU64::new(1)),
        seq: Arc::new(AtomicU64::new(0)),
        model: model.clone(),
        base_url: base_url.clone(),
    });

    let app = Router::new()
        .route("/", get(get_index))
        .route("/assets/app.js", get(get_app_js))
        .route("/assets/style.css", get(get_style_css))
        .route("/api/health", get(get_health))
        .route("/api/events", get(get_events))
        .route("/api/turn", post(post_turn))
        .route("/api/cancel", post(post_cancel))
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
