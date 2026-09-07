// ============================================================================
// api.ts — HTTP 层（单一职责）：所有 REST 调用集中于此，唯一 fetch 出处。
// 封装：请求/响应解析/ApiError；不持有 UI 状态、不做 DOM 操作。
// ============================================================================
import type {
  ActivateResp,
  BatchIdsReq,
  BatchNamesReq,
  CancelResp,
  ClearResp,
  ConfigInfo,
  FsBrowseResp,
  ConfigPatch,
  ConfigSaveResp,
  HealthInfo,
  MessagesResp,
  ProviderFetchResp,
  ProviderTestResp,
  ProvidersResp,
  SessionCreateReq,
  SessionsResp,
  StatusSnapshot,
  ToolsResp,
  TurnResp,
  WorkspacesResp,
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
  /** 热调保存：POST /api/config {patch}（成功响应 = 消毒后完整配置）。 */
  saveConfig: (patch: ConfigPatch) => postJson<ConfigSaveResp>('/api/config', patch),
  sessions: () => requestJson<SessionsResp>('/api/sessions'),
  /** 会话历史（回放/恢复）；404/超时 → ApiError。 */
  messages: (id: string) =>
    requestJson<MessagesResp>('/api/sessions/' + encodeURIComponent(id) + '/messages'),
  clear: () => postJson<ClearResp>('/api/clear', {}),
  turn: (input: string) => postJson<TurnResp>('/api/turn', { input }),
  cancel: () => postJson<CancelResp>('/api/cancel', {}),
  // ---- 工作区 / 会话管理（W236；缺失时 404 优雅降级） ----
  workspaces: () => requestJson<WorkspacesResp>('/api/workspaces'),
  createWorkspace: (name: string, path?: string) =>
    postJson<ClearResp>('/api/workspaces', path ? { name, path } : { name }),
  deleteWorkspace: (name: string) =>
    postJson<ClearResp>('/api/workspaces/' + encodeURIComponent(name) + '/delete', {}),
  batchDeleteWorkspaces: (names: string[]) =>
    postJson<ClearResp>('/api/workspaces/batch-delete', { names } as BatchNamesReq),
  createSession: (req: SessionCreateReq) => postJson<ClearResp>('/api/sessions', req),
  archiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/archive', {}),
  unarchiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/unarchive', {}),
  /** 激活会话（W237）：POST /api/sessions/{id}/activate；409=轮次中。 */
  activateSession: (id: string) =>
    postJson<ActivateResp>('/api/sessions/' + encodeURIComponent(id) + '/activate', {}),
  /** 目录浏览（W237）：GET /api/fs/browse?path=（懒加载列目录，只显示目录）。 */
  fsBrowse: (path?: string) =>
    requestJson<FsBrowseResp>('/api/fs/browse' + (path ? '?path=' + encodeURIComponent(path) : '')),
  batchArchiveSessions: (ids: string[]) =>
    postJson<ClearResp>('/api/sessions/batch-archive', { ids } as BatchIdsReq),
  batchDeleteSessions: (ids: string[]) =>
    postJson<ClearResp>('/api/sessions/batch-delete', { ids } as BatchIdsReq),
  // ---- 模型提供商（W236；缺失时 404 优雅降级） ----
  providers: () => requestJson<ProvidersResp>('/api/providers'),
  saveProvider: (payload: unknown) => postJson<ClearResp>('/api/providers', payload),
  deleteProvider: (id: string) =>
    postJson<ClearResp>('/api/providers/' + encodeURIComponent(id) + '/delete', {}),
  testProvider: (payload: unknown) => postJson<ProviderTestResp>('/api/providers/test', payload),
  fetchProviderModels: (id: string) =>
    postJson<ProviderFetchResp>('/api/providers/' + encodeURIComponent(id) + '/models/fetch', {}),
  setDefaultModel: (model: string) =>
    postJson<ClearResp>('/api/providers/default', { model }),
};
