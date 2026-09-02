// ============================================================================
// Celestea Studio — shared type contracts
// SSE  GET /api/events  event: status|text|thinking|tool|tool_result|done
//      data 为 {"turn":N,"seq":M,"payload":{...}}
//   HTTP  POST /api/turn {input}  ·  POST /api/cancel  ·  GET /api/health
//         GET  /api/tools  ·  GET /api/config  ·  GET /api/sessions  ·  GET /api/status
//         POST /api/clear  ·  POST /api/worker/spawn  ·  POST /api/worker/send
//         GET  /api/worker/status?wid=
// ============================================================================

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

/**
 * Statusline snapshot: what the backend publishes on GET /api/status and
 * incrementally inside SSE status events (shared contract).
 */
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
  workspace?: string;
  events?: number;
  live?: boolean;
}

export interface SessionsResp {
  ok?: boolean;
  sessions?: SessionInfo[];
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

export interface WorkerInfo {
  wid?: string;
  title?: string;
  status?: string;
  phase?: string;
  sessionId?: string;
  model?: string;
  workspace?: string;
  cwd?: string;
  live?: boolean;
}

export interface WorkerStatusResp {
  ok?: boolean;
  total?: number;
  by_status?: Record<string, number>;
  workers?: WorkerInfo[];
  error?: string;
}

export interface WorkerSpawnReq {
  wid: string;
  brief: string;
  title?: string;
  model?: string;
}

export interface WorkerSpawnResp {
  ok?: boolean;
  sessionId?: string;
  title?: string;
  wid?: string;
  step?: string;
  error?: string;
}

export interface WorkerSendReq {
  target?: string;
  content?: string;
}

export interface WorkerSendResp {
  ok?: boolean;
  delivered?: boolean;
  step?: string;
  error?: string;
}

/** /api/config returns a flat JSON object of sanitized keys. */
export type ConfigInfo = Record<string, unknown>;
