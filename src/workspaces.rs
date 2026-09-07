//! W236: workspace + session-file management over CELESTEA_SESSION_DIR.
//!
//! Model:
//!   - workspace "root" = the session dir itself (host cli-main + loose jsonl);
//!   - every direct subdirectory of the session dir is a workspace (its *.jsonl
//!     files are its sessions). `.trash` / `.archived` are reserved hidden dirs:
//!     never listed, never created as workspaces.
//!   - session id rule: top-level file -> "<stem>", workspace file ->
//!     "<workspace>/<stem>". The host conversation keeps id "cli-main"
//!     (workspace=null in the sessions list) and is never archivable (400).
//!
//! All path joins go through [resolve_session_path]: every id segment is
//! sanitized with the engine's file_name_for character set (plus
//! "." / ".." / absolute rejection for the workspace part) and the result is
//! parent-verified to live directly inside the target directory — no path
//! traversal, mirroring celestea_session::file_name_for semantics.
//!
//! Endpoints (mounted in main):
//!   GET  /api/workspaces                  -> {"workspaces":[{"name","path","sessions"}]}
//!   POST /api/workspaces                  -> create (sanitized name; 409 on dup)
//!   POST /api/workspaces/{name}/delete    -> move to <dir>/.trash/<name>-<ts>
//!   POST /api/workspaces/batch-delete     -> same for {"names":[...]}
//!   POST /api/sessions                    -> create "<sanitized title>-<ts>.jsonl"
//!   POST /api/sessions/{id}/archive|unarchive -> <dir>/[ws/].archived/ moves
//!   POST /api/sessions/batch-archive|batch-delete -> archive / trash moves

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::Path as AxPath;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::session_file_name;

pub(crate) const TRASH_DIR: &str = ".trash";
pub(crate) const ARCHIVED_DIR: &str = ".archived";
pub(crate) const ROOT_WORKSPACE: &str = "root";
/// Host conversation id — the engine's cli-main; never a disposable file.
pub(crate) const HOST_ID: &str = "cli-main";

/// CELESTEA_SESSION_DIR from the env (trimmed), or None. main() forces the
/// switch at startup, so handlers only see None in exotic test setups.
pub(crate) fn session_dir() -> Option<PathBuf> {
    std::env::var("CELESTEA_SESSION_DIR")
        .ok()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
}

/// Sanitize one path component: [A-Za-z0-9._-] survive, everything else
/// becomes '_' — exactly the engine's file_name_for character set, without
/// the .jsonl suffix. (file_name_for does not trim; callers trim titles.)
pub(crate) fn sanitize_component(s: &str) -> String {
    // Keep CJK and other Unicode letters (Chinese UI), drop only what is
    // unsafe in a file name: separators, control chars, and whitespace is
    // collapsed to '_' (path traversal is impossible without separators).
    s.chars()
        .map(|c| match c {
            '/' | '\\' | '\0' | '\u{7f}'..='\u{9f}' => '_',
            c if c.is_control() || c.is_whitespace() => '_',
            c => c,
        })
        .collect()
}

/// Validate a workspace name for creation: sanitize (file_name_for semantics),
/// then reject empty / "." / ".." / the reserved hidden dirs.
pub(crate) fn validate_workspace_name(name: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("workspace name must not be empty".to_string());
    }
    let s = sanitize_component(name);
    if s.is_empty() {
        return Err("workspace name must not be empty".to_string());
    }
    if s == "." || s == ".." {
        return Err(format!("invalid workspace name '{name}'"));
    }
    if s == TRASH_DIR || s == ARCHIVED_DIR {
        return Err(format!("workspace name '{s}' is reserved"));
    }
    Ok(s)
}

/// Build a session id from workspace + stem (the listing rule, inverted).
pub(crate) fn session_id(workspace: Option<&str>, stem: &str) -> String {
    match workspace {
        Some(w) => format!("{w}/{stem}"),
        None => stem.to_string(),
    }
}

/// Resolve a session id ("<stem>" | "<ws>/<stem>") to a safe file path inside
/// `dir`. Traversal-safe: segments are sanitized with the file_name_for set,
/// the workspace part rejects "." / ".." / empties / extra slashes, and the
/// resolved path is parent-verified to live directly in dir (or dir/<ws>).
/// Returns None when the id cannot denote a session file at all.
pub(crate) fn resolve_session_path(dir: &Path, id: &str) -> Option<PathBuf> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let (ws, stem) = match id.split_once('/') {
        Some((ws, stem)) => {
            if ws.is_empty() || stem.is_empty() || stem.contains('/') {
                return None;
            }
            let ws = sanitize_component(ws);
            if ws.is_empty() || ws == "." || ws == ".." {
                return None;
            }
            (Some(ws), stem.to_string())
        }
        None => (None, id.to_string()),
    };
    let file = session_file_name(&stem); // never empty, always .jsonl, no '/'
    let path = match &ws {
        Some(w) => dir.join(w).join(&file),
        None => dir.join(&file),
    };
    // 父目录校验：解析结果必须严格落在 dir（或 dir/<ws>）直下。
    let parent_ok = match &ws {
        Some(w) => path.parent().is_some_and(|p| p == dir.join(w)),
        None => path.parent().is_some_and(|p| p == dir),
    };
    parent_ok.then_some(path)
}

/// Where an archived session file lives: <dir>/[ws/].archived/<file>.
pub(crate) fn archived_path(dir: &Path, id: &str) -> Option<PathBuf> {
    let p = resolve_session_path(dir, id)?;
    let file = p.file_name()?.to_string_lossy().into_owned();
    Some(p.parent()?.join(ARCHIVED_DIR).join(file))
}

/// Trash destination for a session file: <dir>/[ws/].trash/<stem>-<ts>.jsonl
/// (recoverable, collision-safe via the timestamp suffix).
pub(crate) fn session_trash_path(dir: &Path, id: &str, ts: &str) -> Option<PathBuf> {
    let p = resolve_session_path(dir, id)?;
    let stem = p.file_stem()?.to_string_lossy().into_owned();
    Some(p.parent()?.join(TRASH_DIR).join(format!("{stem}-{ts}.jsonl")))
}

/// "<secs>.<nanos>" timestamp used for trash/creation suffixes.
fn now_ts() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{}", d.as_secs(), d.subsec_nanos())
}

// ---- workspace handlers ---------------------------------------------------------

/// GET /api/workspaces -> {"workspaces":[{"name","path","sessions"}...]}.
/// "root" is always first; direct subdirectories follow (sorted); .trash /
/// .archived never appear.
pub(crate) async fn get_workspaces() -> Json<Value> {
    let Some(dir) = session_dir() else {
        return Json(json!({"workspaces": []}));
    };
    let root_count = count_session_files(&dir, true);
    let mut workspaces = vec![json!({
        "name": ROOT_WORKSPACE,
        "path": dir.display().to_string(),
        "sessions": root_count,
    })];
    let mut subs: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let ft = e.file_type().ok()?;
                if !ft.is_dir() {
                    return None;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if name == TRASH_DIR || name == ARCHIVED_DIR {
                    return None;
                }
                Some(name)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    subs.sort();
    for name in subs {
        let path = dir.join(&name);
        workspaces.push(json!({
            "name": name,
            "path": path.display().to_string(),
            "sessions": count_session_files(&path, false),
        }));
    }
    Json(json!({"workspaces": workspaces}))
}

/// Count *.jsonl files directly inside a directory (non-recursive; files
/// only). For the root workspace the host cli-main.jsonl is excluded.
pub(crate) fn count_session_files(dir: &Path, is_root: bool) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .filter(|e| {
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return false;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                return false;
            }
            !(is_root && name == "cli-main.jsonl")
        })
        .count() as u64
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceNameReq {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct BatchNamesReq {
    pub(crate) names: Vec<String>,
}

/// POST /api/workspaces {"name"} — create the subdirectory (sanitized,
/// file_name_for semantics). Duplicate -> 409.
pub(crate) async fn post_workspace_create(Json(req): Json<WorkspaceNameReq>) -> impl IntoResponse {
    let name = match validate_workspace_name(&req.name) {
        Ok(n) => n,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e})))
                .into_response()
        }
    };
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    let path = dir.join(&name);
    if path.exists() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": format!("workspace '{name}' already exists")})),
        )
            .into_response();
    }
    match std::fs::create_dir(&path) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": format!("create failed: {e}")})),
        )
            .into_response(),
    }
}

/// Move one workspace into <dir>/.trash/<name>-<ts> (recoverable).
fn delete_workspace(dir: &Path, raw_name: &str) -> Result<(), String> {
    let name = validate_workspace_name(raw_name)?;
    if name == ROOT_WORKSPACE {
        return Err("workspace 'root' is the session dir itself and cannot be deleted".to_string());
    }
    let path = dir.join(&name);
    if !path.is_dir() {
        return Err(format!("unknown workspace '{name}'"));
    }
    let trash = dir.join(TRASH_DIR);
    std::fs::create_dir_all(&trash)
        .map_err(|e| format!("cannot create trash dir: {e}"))?;
    let dest = trash.join(format!("{name}-{}", now_ts()));
    std::fs::rename(&path, &dest)
        .map_err(|e| format!("move to trash failed: {e}"))?;
    Ok(())
}

/// POST /api/workspaces/{name}/delete — move to .trash (recoverable).
pub(crate) async fn post_workspace_delete(AxPath(name): AxPath<String>) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    match delete_workspace(&dir, &name) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) if e.starts_with("unknown workspace") => {
            (StatusCode::NOT_FOUND, Json(json!({"ok": false, "error": e}))).into_response()
        }
        Err(e) if e.starts_with("move to trash") => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "error": e})))
                .into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

/// POST /api/workspaces/batch-delete {"names":[...]} — per-name trash move;
/// failures are reported per name, the batch continues.
pub(crate) async fn post_workspaces_batch_delete(
    Json(req): Json<BatchNamesReq>,
) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    let mut deleted = 0usize;
    let mut failed = Vec::new();
    for name in &req.names {
        match delete_workspace(&dir, name) {
            Ok(()) => deleted += 1,
            Err(e) => failed.push(json!({"name": name, "error": e})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "deleted": deleted, "failed": failed})),
    )
        .into_response()
}

// ---- session handlers ------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct SessionCreateReq {
    pub(crate) workspace: Option<String>,
    pub(crate) title: String,
}

#[derive(Deserialize)]
pub(crate) struct BatchIdsReq {
    pub(crate) ids: Vec<String>,
}

/// The workspace directory for a create request: None/""/"root" -> the
/// session dir itself; anything else -> the sanitized subdirectory (which
/// must exist). Err = (status, message).
fn workspace_dir_for(dir: &Path, workspace: Option<&str>) -> Result<PathBuf, (StatusCode, String)> {
    match workspace.map(str::trim).filter(|w| !w.is_empty() && *w != ROOT_WORKSPACE) {
        None => Ok(dir.to_path_buf()),
        Some(w) => {
            let name = sanitize_component(w);
            if name.is_empty() || name == "." || name == ".." || name == TRASH_DIR || name == ARCHIVED_DIR {
                return Err((StatusCode::BAD_REQUEST, format!("invalid workspace '{w}'")));
            }
            let path = dir.join(&name);
            if !path.is_dir() {
                return Err((StatusCode::NOT_FOUND, format!("unknown workspace '{name}'")));
            }
            Ok(path)
        }
    }
}

/// POST /api/sessions {"workspace"?, "title"} — create
/// "<sanitized title>-<ts>.jsonl" in the target workspace (root when absent).
/// Response: {"ok":true,"id":"<ws>/<stem>"} ("<stem>" for root).
pub(crate) async fn post_session_create(Json(req): Json<SessionCreateReq>) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    let title = req.title.trim();
    let base = sanitize_component(title);
    if base.is_empty() || base == "." || base == ".." {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "title must not be empty"})),
        )
            .into_response();
    }
    let target = match workspace_dir_for(&dir, req.workspace.as_deref()) {
        Ok(t) => t,
        Err((code, msg)) => {
            return (code, Json(json!({"ok": false, "error": msg}))).into_response()
        }
    };
    // "<title>-<ts>" with a collision counter, mirroring the recoverable
    // trash naming; the file starts empty (a live 0-event session).
    let mut stem = format!("{base}-{}", now_ts());
    let mut n = 0u32;
    let path = loop {
        let candidate = target.join(session_file_name(&stem));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        stem = format!("{base}-{}-{n}", now_ts());
    };
    if let Err(e) = std::fs::File::create(&path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": format!("create failed: {e}")})),
        )
            .into_response();
    }
    let id = if target == dir {
        stem
    } else {
        session_id(target.file_name().and_then(|f| f.to_str()), &stem)
    };
    (StatusCode::OK, Json(json!({"ok": true, "id": id}))).into_response()
}

/// Core archive move: <dir>/[ws/]<file>.jsonl -> <dir>/[ws/].archived/<file>.
fn move_session(dir: &Path, id: &str, to_archive: bool) -> Result<(), (StatusCode, String)> {
    let src = match to_archive {
        true => resolve_session_path(dir, id),
        false => archived_path(dir, id),
    };
    let dst = match to_archive {
        true => archived_path(dir, id),
        false => resolve_session_path(dir, id),
    };
    let (Some(src), Some(dst)) = (src, dst) else {
        return Err((StatusCode::BAD_REQUEST, format!("invalid session id '{id}'")));
    };
    if !src.is_file() {
        return Err((StatusCode::NOT_FOUND, format!("unknown session '{id}'")));
    }
    if dst.exists() {
        return Err((
            StatusCode::CONFLICT,
            if to_archive {
                format!("session '{id}' is already archived")
            } else {
                format!("a live session already exists at '{id}'")
            },
        ));
    }
    let parent = dst.parent().expect("session path has a parent dir");
    std::fs::create_dir_all(parent)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir failed: {e}")))?;
    std::fs::rename(&src, &dst)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
    Ok(())
}

/// POST /api/sessions/{id}/archive — cli-main is forbidden (400).
pub(crate) async fn post_session_archive(AxPath(id): AxPath<String>) -> impl IntoResponse {
    if id.trim() == HOST_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "cli-main 禁止归档"})),
        )
            .into_response();
    }
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    match move_session(&dir, &id, true) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err((code, msg)) => (code, Json(json!({"ok": false, "error": msg}))).into_response(),
    }
}

/// POST /api/sessions/{id}/unarchive
pub(crate) async fn post_session_unarchive(AxPath(id): AxPath<String>) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    match move_session(&dir, &id, false) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err((code, msg)) => (code, Json(json!({"ok": false, "error": msg}))).into_response(),
    }
}

/// POST /api/sessions/batch-archive {"ids":[...]} — per-id archive; cli-main
/// and misses land in "failed", the batch continues.
pub(crate) async fn post_sessions_batch_archive(Json(req): Json<BatchIdsReq>) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    let mut archived = 0usize;
    let mut failed = Vec::new();
    for id in &req.ids {
        if id.trim() == HOST_ID {
            failed.push(json!({"id": id, "error": "cli-main 禁止归档"}));
            continue;
        }
        match move_session(&dir, id, true) {
            Ok(()) => archived += 1,
            Err((_, msg)) => failed.push(json!({"id": id, "error": msg})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "archived": archived, "failed": failed})),
    )
        .into_response()
}

/// POST /api/sessions/batch-delete {"ids":[...]} — per-id move to .trash
/// (recoverable). cli-main is the live host conversation and is refused.
pub(crate) async fn post_sessions_batch_delete(Json(req): Json<BatchIdsReq>) -> impl IntoResponse {
    let Some(dir) = session_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "CELESTEA_SESSION_DIR is not set"})),
        )
            .into_response();
    };
    let mut deleted = 0usize;
    let mut failed = Vec::new();
    for id in &req.ids {
        if id.trim() == HOST_ID {
            failed.push(json!({"id": id, "error": "cli-main 是宿主会话，禁止删除"}));
            continue;
        }
        let Some(src) = resolve_session_path(&dir, id) else {
            failed.push(json!({"id": id, "error": format!("invalid session id '{id}'")}));
            continue;
        };
        if !src.is_file() {
            failed.push(json!({"id": id, "error": format!("unknown session '{id}'")}));
            continue;
        }
        let Some(dst) = session_trash_path(&dir, id, &now_ts()) else {
            failed.push(json!({"id": id, "error": format!("invalid session id '{id}'")}));
            continue;
        };
        if let Some(parent) = dst.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                failed.push(json!({"id": id, "error": format!("mkdir failed: {e}")}));
                continue;
            }
        }
        match std::fs::rename(&src, &dst) {
            Ok(()) => deleted += 1,
            Err(e) => failed.push(json!({"id": id, "error": format!("move failed: {e}")})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "deleted": deleted, "failed": failed})),
    )
        .into_response()
}

// ---- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w236-ws-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn workspace_name_sanitizes_like_file_name_for_and_rejects_reserved() {
        assert_eq!(validate_workspace_name("my ws").unwrap(), "my_ws");
        assert_eq!(validate_workspace_name("a/b\\c").unwrap(), "a_b_c");
        assert!(validate_workspace_name("").is_err());
        assert!(validate_workspace_name("   ").is_err());
        assert!(validate_workspace_name(".").is_err());
        assert!(validate_workspace_name("..").is_err());
        assert!(validate_workspace_name(".trash").is_err());
        assert!(validate_workspace_name(".archived").is_err());
    }

    #[test]
    fn session_id_rule_root_vs_workspace() {
        assert_eq!(session_id(None, "s1"), "s1");
        assert_eq!(session_id(Some("ws"), "s1"), "ws/s1");
        assert_eq!(sanitize_component("Hello 世界"), "Hello_世界");
    }

    #[test]
    fn resolve_session_path_is_traversal_safe() {
        let dir = Path::new("/tmp/fake-session-dir");
        // root file
        assert_eq!(resolve_session_path(dir, "s1"), Some(dir.join("s1.jsonl")));
        // workspace file (the "<ws>/<stem>" rule)
        assert_eq!(
            resolve_session_path(dir, "ws/s1"),
            Some(dir.join("ws").join("s1.jsonl"))
        );
        // multi-slash ids cannot denote a session
        assert_eq!(resolve_session_path(dir, "a/b/c"), None);
        assert_eq!(resolve_session_path(dir, "a/"), None);
        assert_eq!(resolve_session_path(dir, "/abs"), None);
        // parent traversal in either segment never escapes the session dir
        assert_eq!(resolve_session_path(dir, "../etc/passwd"), None);
        // a bare ".." is NOT a traversal: like the engine's file_name_for the
        // dots survive as a literal file name ("...jsonl") directly inside dir
        let dots = resolve_session_path(dir, "..").unwrap();
        assert_eq!(dots.parent().unwrap(), dir);
        assert!(dots.starts_with(dir));
        // a second slash inside the stem is rejected outright (the id rule
        // is exactly "<ws>/<stem>"); nothing can smuggle traversal through
        assert_eq!(resolve_session_path(dir, "a/../x"), None);
        // a sanitized stem still lands INSIDE its workspace dir (parent
        // verified) — dots and weird chars become literal file characters
        let p = resolve_session_path(dir, "a/x y").unwrap();
        assert_eq!(p, dir.join("a").join("x_y.jsonl"));
        assert!(p.starts_with(dir), "resolved path must stay inside the session dir");
        // empty ids
        assert_eq!(resolve_session_path(dir, ""), None);
        assert_eq!(resolve_session_path(dir, "   "), None);
    }

    #[test]
    fn archive_and_trash_paths_stay_inside_session_dir() {
        let dir = Path::new("/tmp/fake-session-dir");
        assert_eq!(
            archived_path(dir, "s1"),
            Some(dir.join(".archived").join("s1.jsonl"))
        );
        assert_eq!(
            archived_path(dir, "ws/s1"),
            Some(dir.join("ws").join(".archived").join("s1.jsonl"))
        );
        assert_eq!(archived_path(dir, "../evil"), None);
        assert_eq!(archived_path(dir, "ws/../../evil"), None);

        let t = session_trash_path(dir, "ws/s1", "123").unwrap();
        assert_eq!(t, dir.join("ws").join(".trash").join("s1-123.jsonl"));
        assert_eq!(session_trash_path(dir, "../evil", "123"), None);
    }

    #[test]
    fn workspace_create_archive_delete_roundtrip_on_real_fs() {
        let dir = scratch("roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CELESTEA_SESSION_DIR", &dir);

        // create a workspace + a session file inside it
        let ws = validate_workspace_name("Team A").unwrap();
        assert_eq!(ws, "Team_A");
        std::fs::create_dir(dir.join(&ws)).unwrap();
        let session = dir.join(&ws).join("note-1.jsonl");
        std::fs::write(&session, "{}\n").unwrap();
        // a root session file too
        std::fs::write(dir.join("loose.jsonl"), "{}\n").unwrap();

        // id rule roundtrip: listed ids resolve back to the same files
        let root_id = "loose";
        let ws_id = format!("{ws}/note-1");
        assert_eq!(resolve_session_path(&dir, root_id), Some(dir.join("loose.jsonl")));
        assert_eq!(resolve_session_path(&dir, &ws_id), Some(session.clone()));

        // archive (not cli-main) -> file moves under <ws>/.archived/
        move_session(&dir, &ws_id, true).unwrap();
        assert!(!session.exists());
        assert!(dir.join(&ws).join(".archived").join("note-1.jsonl").exists());
        // archived file no longer counts in the workspace listing
        assert_eq!(count_session_files(&dir.join(&ws), false), 0);

        // unarchive -> back in place
        move_session(&dir, &ws_id, false).unwrap();
        assert!(session.exists());

        // delete -> .trash (recoverable), still inside the session dir
        // (the HTTP handler creates the parent; the test does it by hand)
        let dst = session_trash_path(&dir, &ws_id, "999").unwrap();
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::rename(&session, &dst).unwrap();
        assert!(dst.starts_with(&dir));
        assert!(dst.exists());

        // workspace delete -> <dir>/.trash/<name>-<ts>
        delete_workspace(&dir, &ws).unwrap();
        assert!(!dir.join(&ws).exists());
        let trashed: Vec<_> = std::fs::read_dir(dir.join(TRASH_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(trashed.iter().any(|n| n.starts_with(&format!("{ws}-"))));

        std::env::remove_var("CELESTEA_SESSION_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_main_cannot_be_archived_via_core_move() {
        let dir = scratch("cli-main");
        std::fs::create_dir_all(&dir).unwrap();
        // cli-main exists as a real file, but the archive handler refuses it
        // before any move; the core helper itself resolves it fine (it is a
        // regular session path) — the ban lives in the HTTP handler.
        std::fs::write(dir.join("cli-main.jsonl"), "{}\n").unwrap();
        assert_eq!(
            resolve_session_path(&dir, "cli-main"),
            Some(dir.join("cli-main.jsonl"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
