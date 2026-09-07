// ============================================================================
// Celestea Studio — shared type contracts
// SSE  GET /api/events  event: status|text|thinking|tool|tool_result|done
//      data 为 {"turn":N,"seq":M,"payload":{...}}
//   HTTP  POST /api/turn {input} · POST /api/cancel · POST /api/config {patch}
//         GET /api/health · GET /api/tools · GET /api/config · GET /api/sessions
//         GET /api/status · POST /api/clear
// 视图层合同（AssistantView / ToolOpView）见 ui/view.ts（与 API 合同分离）。
// ============================================================================

// ---- SSE -------------------------------------------------------------------

/** SSE envelope: every event carries { turn, seq, payload }. */
export interface SseEnvelope {
  turn?: number;
  seq?: number;
  payload?: Record<string, unknown>;
}

/** SSE event names (mirrored from the engine LoopEvent variants). */
export type SseEventName = 'status' | 'text' | 'thinking' | 'tool' | 'tool_result' | 'done';

export type ConnState = 'connecting' | 'online' | 'down';

// ---- statusline / runtime status ------------------------------------------

export interface ContextUsage {
  used: number;
  window: number;
  ratio: number;
}

/** Statusline snapshot (GET /api/status + SSE status 增量字段，共享合同). */
export interface StatusSnapshot {
  model?: string;
  reasoning_effort?: string | null;
  steps?: number;
  tokens_per_sec?: number;
  context_usage?: ContextUsage;
}

/** status SSE payload: turn lifecycle + optional statusline fields. */
export interface StatusPayload extends StatusSnapshot {
  phase?: 'start' | 'completed' | 'cancelled' | 'error' | 'lagged';
  turn?: number;
  error?: string;
  hint?: string;
}

export interface TextPayload {
  turn?: number;
  delta: string;
}

export interface ThinkingPayload {
  turn?: number;
  delta: string;
}

export interface ToolPayload {
  turn?: number;
  id: string;
  name?: string;
  args?: unknown;
}

export interface ToolResultPayload {
  turn?: number;
  id: string;
  ok?: boolean;
  value?: unknown;
  render?: string;
  error?: string | null;
  decision?: 'allow' | 'deny' | 'ask' | null;
}

export interface DonePayload {
  turn?: number;
  text?: string;
  tool_calls?: ToolPayload[];
}

// ---- REST -------------------------------------------------------------------

export interface HealthInfo {
  ok?: boolean;
  name?: string;
  model?: string;
  base_url?: string;
  bind?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ToolsResp {
  ok?: boolean;
  tools?: ToolInfo[];
  error?: string;
}

export interface SessionInfo {
  id?: string;
  title?: string;
  kind?: string;
  workspace?: string | null;
  events?: number;
  live?: boolean;
  file?: string;
  size?: number;
  modified?: number;
  archived?: boolean;
  /** W237：是否为当前活跃会话 */
  active?: boolean;
}

export interface SessionsResp {
  ok?: boolean;
  sessions?: SessionInfo[];
  error?: string;
}

// ---- 会话历史（GET /api/sessions/{id}/messages，回放/恢复用） --------------------

export type HistoryRole = 'user' | 'assistant' | 'tool';

export interface HistoryMsg {
  role: HistoryRole;
  content: string;
}

export interface MessagesResp {
  ok?: boolean;
  session?: string;
  messages?: HistoryMsg[];
  error?: string;
}

// ---- 工作区 / 会话管理（W236） ------------------------------------------------

export interface WorkspaceInfo {
  name: string;
  path?: string;
  sessions?: number;
}

export interface WorkspacesResp {
  ok?: boolean;
  workspaces?: WorkspaceInfo[];
  active_session?: string | null;
  error?: string;
}

/** POST /api/sessions/{id}/activate 响应。 */
export interface ActivateResp {
  ok?: boolean;
  active_session?: string;
  error?: string;
}

/** GET /api/fs/browse?path= 响应（目录浏览；只列目录）。 */
export interface FsBrowseResp {
  path?: string;
  parent?: string | null;
  dirs?: string[];
  roots?: string[];
  error?: string;
}

export interface SessionCreateReq {
  workspace?: string | null;
  title: string;
}

export interface BatchIdsReq {
  ids?: string[];
}

export interface BatchNamesReq {
  names?: string[];
}

// ---- 模型提供商（W236） --------------------------------------------------------

export interface ProviderModelSpec {
  id: string;
  name: string;
  reasoning_efforts?: string[];
  context_window?: number | null;
  max_output_tokens?: number | null;
}

export interface ProviderInfo {
  id: string;
  name?: string;
  note?: string;
  base_url?: string;
  request_format?: string;
  models?: ProviderModelSpec[];
  is_default?: boolean;
  has_key?: boolean;
}

export interface ProvidersResp {
  ok?: boolean;
  providers?: ProviderInfo[];
  default_model?: string | null;
  error?: string;
}

export interface ProviderTestResp {
  ok?: boolean;
  latency_ms?: number;
  model_count?: number;
  error?: string;
}

export interface ProviderFetchResp {
  ok?: boolean;
  models?: { id: string }[];
  error?: string;
}

export interface OkResp {
  ok?: boolean;
  error?: string;
}

export interface ClearResp extends OkResp {}

export interface CancelResp extends OkResp {}

export interface TurnResp {
  ok?: boolean;
  turn?: number;
  error?: string;
}

// ---- 配置（GET /api/config · POST /api/config） ----------------------------

/** available.models 条目：id=引擎模型标识，name=展示名。 */
export interface ModelInfo {
  id: string;
  name: string;
  reasoning?: boolean;
}

/** 可选清单（后端发布时携带；缺失则前端降级为手输/预置档位）。 */
export interface ConfigAvailable {
  models?: ModelInfo[];
  efforts?: string[];
}

/** GET /api/config 返回的安全 Profile（永不携带 api_key 明文）。 */
export interface ConfigInfo {
  model?: string;
  base_url?: string;
  /** 后端通过 env/file 配密钥时返回 null；前端永不显示/回传真实值。 */
  api_key?: string | null;
  context_window?: number | null;
  context_window_tokens?: number | null;
  max_steps?: number | null;
  max_parallel_tool_calls?: number | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  system_prompt?: string | null;
  available?: ConfigAvailable;
}

/** POST /api/config 热调补丁：只携带用户改动的键（空值=不改）。 */
export interface ConfigPatch {
  model?: string;
  base_url?: string;
  api_key?: string;
  context_window?: number | null;
  max_steps?: number | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  system_prompt?: string;
}

/** POST /api/config 成功响应 = 消毒后的完整配置（同 GET 体型）。 */
export type ConfigSaveResp = ConfigInfo & OkResp;
