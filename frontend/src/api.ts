// ============================================================================
// api.ts — HTTP 层（单一职责）：所有 REST 调用集中于此，唯一 fetch 出处。
// 封装：请求/响应解析/ApiError；不持有 UI 状态、不做 DOM 操作。
// ============================================================================
import type {
  CancelResp,
  ClearResp,
  ConfigInfo,
  ConfigPatch,
  HealthInfo,
  OkResp,
  SessionsResp,
  StatusSnapshot,
  ToolsResp,
  TurnResp,
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
    const msg =
      obj && typeof obj.error === 'string'
        ? obj.error
        : res.status === 405 || res.status === 404
          ? 'HTTP ' + res.status + ' · 后端未开放该接口'
          : 'HTTP ' + res.status;
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
  /** 当前运行配置（安全剖面，不含密钥）。 */
  config: () => requestJson<ConfigInfo>('/api/config'),
  /** 热调保存：POST /api/config {patch}。 */
  saveConfig: (patch: ConfigPatch) => postJson<OkResp>('/api/config', patch),
  sessions: () => requestJson<SessionsResp>('/api/sessions'),
  clear: () => postJson<ClearResp>('/api/clear', {}),
  turn: (input: string) => postJson<TurnResp>('/api/turn', { input }),
  cancel: () => postJson<CancelResp>('/api/cancel', {}),
};
