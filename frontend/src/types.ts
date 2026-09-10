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
  /** W514: envelope version (2 = carries `session`; absent/1 = legacy single-session). */
  v?: number;
  /** W514: target session id — the frontend routes every frame by this field. */
  session?: string;
  turn?: number;
  seq?: number;
  payload?: Record<string, unknown>;
}

/**
 * W514: fields the envelope contributes to every payload (the SSE client merges
 * them flat). All optional — a legacy backend omits them and the frontend falls
 * back to the single-session behaviour.
 */
export interface SseMeta {
  v?: number;
  session?: string;
  turn?: number;
  seq?: number;
}

/** SSE event names (mirrored from the engine LoopEvent variants). */
export type SseEventName =
  | 'status'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'done'
  | 'context'
  | 'compact'
  /** W515：Agent Inbox / worker 回执等系统注入（kind='inbox' 的转录条目）。 */
  | 'inbox';

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
  /** W263: engine token usage (latest LLM stream + cumulative `total`). */
  usage?: UsageSnapshot;
  /** W237/W514: the session this snapshot describes (GET /api/status?session=). */
  session?: string | null;
  /** W514: whether that session currently has a turn running (may be absent). */
  busy?: boolean;
}

/**
 * W263: one usage block — provider-reported counters of one LLM stream.
 * `cache_hit_ratio` = cache_read / prompt_tokens (0 when prompt_tokens == 0).
 */
export interface UsageCounters {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_hit_ratio: number;
  reasoning_tokens: number;
}

/** W263: latest stream + cumulative (`total`) usage counters. */
export interface UsageSnapshot extends UsageCounters {
  total?: UsageCounters;
}

/** status SSE payload: turn lifecycle + optional statusline fields. */
export interface StatusPayload extends StatusSnapshot {
  /** W514: envelope version (2 = carries `session`). */
  v?: number;
  /** W514: `session` is inherited from StatusSnapshot (may be null on legacy). */
  seq?: number;
  phase?: 'start' | 'completed' | 'cancelled' | 'error' | 'lagged';
  turn?: number;
  error?: string;
  hint?: string;
  /**
   * W263: the backend nests the statusline snapshot under `statusline`
   * ({"phase":"progress","statusline":{...}}); flat fields stay supported.
   */
  statusline?: StatusSnapshot;
}

export interface TextPayload extends SseMeta {
  delta: string;
}

export interface ThinkingPayload extends SseMeta {
  delta: string;
}

export interface ToolPayload extends SseMeta {
  id: string;
  name?: string;
  args?: unknown;
}

export interface ToolResultPayload extends SseMeta {
  id: string;
  ok?: boolean;
  value?: unknown;
  render?: string;
  error?: string | null;
  decision?: 'allow' | 'deny' | 'ask' | null;
}

export interface DonePayload extends SseMeta {
  text?: string;
  tool_calls?: ToolPayload[];
}

/** context 类事件（W240：上下文注入 / 裁剪等系统提示）。 */
export interface ContextPayload extends SseMeta {
  text?: string;
  cls?: string;
}

/**
 * W515：inbox 事件（Agent Inbox / worker 回执 / 系统注入）。
 * DSH 的 inbox 分两车道：next-step（steer，最近 step 边界插入）与
 * next-turn（queue，下一回合独立投递）——前端只负责分类展示。
 * 字段全部可选：后端未就绪时不发该事件（现状降级）。
 */
export interface InboxPayload extends SseMeta {
  /** 展示文本（缺省时回落到 note/hint）。 */
  text?: string;
  /** 来源标记：worker id / 'system' 等。 */
  source?: string;
  /** 'next-step' | 'next-turn'（与 InboxTarget 对齐）。 */
  target?: string;
  note?: string;
  hint?: string;
}

/** compact 类事件（W259：/compact 压缩完成；payload 带会话 id）。 */
export interface CompactPayload {
  session?: string;
  kept_turns?: number;
  note?: string;
  rebound?: boolean;
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
  /** W514: 'session' | 'worker' (absent on legacy backends). */
  kind?: 'session' | 'worker' | string;
  /** W514: a turn is running on this session (absent on legacy backends). */
  busy?: boolean;
  workspace?: string | null;
  events?: number;
  live?: boolean;
  model?: string;
  file?: string;
  size?: number;
  modified?: number;
  archived?: boolean;
  /** W237：是否为当前活跃会话 */
  active?: boolean;
  /**
   * W515：谱系父会话 id（对齐 DSH 的 parentSessionId）。
   * 兼容三种写法：parent / parentSessionId / parent_session；缺失 → 现状平坦展示。
   */
  parent?: string | null;
  parentSessionId?: string | null;
  parent_session?: string | null;
}

export interface SessionsResp {
  ok?: boolean;
  sessions?: SessionInfo[];
  error?: string;
}

// ---- 会话历史（GET /api/sessions/{id}/messages，回放/恢复用） --------------------

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'thinking' | 'inbox';

/**
 * 消息契约（W252 结构化，无兼容层）：
 *   user/assistant/thinking → content 文本；
 *   tool → kind='call'（tool_call_id/tool_name/tool_args）
 *          或 kind='result'（tool_call_id/tool_value/tool_error）。
 */
export interface HistoryMsg {
  role: HistoryRole;
  /** 普通消息文本（tool 消息无此字段）。 */
  content?: string;
  /**
   * tool 消息：'call' | 'result'；
   * user 消息（W515）：'steering'（插话）/ 'queued'（排队）；
   * 'inbox'（worker 回执 / 系统注入）。
   */
  kind?: 'call' | 'result' | 'steering' | 'queued' | 'inbox';
  /** W515：inbox 条目的来源标记（worker id 等）。 */
  source?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_args?: unknown;
  tool_value?: unknown;
  tool_error?: string | null;
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

/** POST /api/sessions/{id}/compact 响应（W259：三态——压缩/无需压缩/错误）。 */
export interface CompactResp {
  ok?: boolean;
  /** true=已压缩；false=历史不足，无需压缩（note 给出说明）。 */
  compacted?: boolean;
  kept_turns?: number;
  note?: string;
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
  /** W243：可选模型（空=跟随默认）。 */
  model?: string;
  /** W245：绑定提示词（空=跟随默认）。 */
  prompt?: string;
}

/** POST /api/sessions 响应（W243 起携带新会话 id）。 */
export interface SessionCreateResp extends OkResp {
  id?: string;
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

// ---- 提示词系统（W245） -----------------------------------------------------------

export interface PromptSection {
  id: string;
  name: string;
  template: string;
  order: number;
  scope: 'builtin' | 'global' | 'workspace';
}

export interface PromptInfo {
  id: string;
  name: string;
  is_default?: boolean;
  /** 段覆盖（编辑弹窗打开时必须回填，否则保存会清掉旧覆盖）。 */
  section_overrides?: Record<string, string>;
  scope: 'global' | 'workspace';
  shadowed?: boolean;
}

export interface PromptsResp {
  ok?: boolean;
  /** 显式 scope（后端固定声明；客户端不再从空值推断）。 */
  scope?: 'global' | 'workspace';
  sections?: PromptSection[];
  prompts?: PromptInfo[];
  default_prompt?: string | null;
  active_prompt?: string | null;
  error?: string;
}

/** POST /api/prompts upsert 载荷（P0-4：不传 workspace=全局）。 */
export interface PromptUpsertReq {
  workspace?: string;
  id: string;
  name: string;
  section_overrides: Record<string, string>;
  is_default?: boolean;
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
  /**
   * W514: true = the input was injected into the running turn (no new turn),
   * false/absent = a new turn was started with `turn` as its id.
   */
  injected?: boolean;
  /** W515: true = 已按「排队（下一回合投递）」接收（mode='queue'）。 */
  queued?: boolean;
  /** W515: 后端回声的投递车道（'next-step' | 'next-turn'）。 */
  inbox_target?: string;
  /** W514: session the turn (or the injection) belongs to. */
  session?: string;
  error?: string;
}

// ---- 配置（GET /api/config · POST /api/config） ----------------------------

/** available.models 条目：id=引擎模型标识，name=展示名（未定义时后端取 id）。 */
export interface ModelInfo {
  id: string;
  name: string;
  /** W262：提供商显示名；静态兜底目录的条目为空串（前端归入「其他」组）。 */
  provider?: string;
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
