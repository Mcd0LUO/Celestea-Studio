// ============================================================================
// REST client for the Celestea Studio backend
// ============================================================================
import type {
  CancelResp,
  ClearResp,
  ConfigInfo,
  HealthInfo,
  SessionsResp,
  StatusSnapshot,
  ToolsResp,
  TurnResp,
  WorkerSendReq,
  WorkerSendResp,
  WorkerSpawnReq,
  WorkerSpawnResp,
  WorkerStatusResp,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(message: string, status = 0, data: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError('网络不可达（' + (e instanceof Error ? e.message : String(e)) + '）', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const obj = data as { error?: unknown } | null;
    const msg = obj && typeof obj.error === 'string' ? obj.error : 'HTTP ' + res.status;
    throw new ApiError(msg, res.status, data);
  }
  return (data ?? {}) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  health: () => requestJson<HealthInfo>('/api/health'),
  /** Statusline fallback source (polled + SSE incremental). */
  status: () => requestJson<StatusSnapshot>('/api/status'),
  tools: () => requestJson<ToolsResp>('/api/tools'),
  config: () => requestJson<ConfigInfo>('/api/config'),
  sessions: () => requestJson<SessionsResp>('/api/sessions'),
  clear: () => postJson<ClearResp>('/api/clear', {}),
  turn: (input: string) => postJson<TurnResp>('/api/turn', { input }),
  cancel: () => postJson<CancelResp>('/api/cancel', {}),
  workerSpawn: (body: WorkerSpawnReq) => postJson<WorkerSpawnResp>('/api/worker/spawn', body),
  workerSend: (body: WorkerSendReq) => postJson<WorkerSendResp>('/api/worker/send', body),
  workerStatus: (wid: string) =>
    requestJson<WorkerStatusResp>('/api/worker/status?wid=' + encodeURIComponent(wid)),
};
