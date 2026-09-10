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
  CompactResp,
  ConfigInfo,
  FsBrowseResp,
  ConfigPatch,
  ConfigSaveResp,
  HealthInfo,
  MessagesResp,
  ProviderFetchResp,
  ProviderTestResp,
  ProvidersResp,
  PromptUpsertReq,
  PromptsResp,
  SessionCreateReq,
  SessionCreateResp,
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
  /**
   * Statusline fallback source (polled + SSE incremental).
   * W514: `session` 非空 → GET /api/status?session=<id>（任意会话状态；旧后端
   * 忽略该参数，返回活跃会话快照 = 现状行为）。
   */
  status: (session?: string) =>
    requestJson<StatusSnapshot>(
      '/api/status' + (session ? '?session=' + encodeURIComponent(session) : ''),
    ),
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
  /**
   * W514：POST /api/turn {input, session?}——目标会话空闲 → 开新轮；
   * 运行中 → 作为插话注入该轮（响应 injected=true，不新开轮）。
   * 旧后端忽略多余字段（serde 默认），仍按现状返回 409/新轮。
   */
  turn: (input: string, session?: string) =>
    postJson<TurnResp>('/api/turn', session ? { input, session } : { input }),
  /** 取消当前聚焦会话的轮次（W514：带 session，旧后端忽略）。 */
  cancel: (session?: string) => postJson<CancelResp>('/api/cancel', session ? { session } : {}),
  // ---- 工作区 / 会话管理（W236；缺失时 404 优雅降级） ----
  workspaces: () => requestJson<WorkspacesResp>('/api/workspaces'),
  /** W243 任务2：纯文件管理器建工作区——仅按目录注册（name 由后端取文件夹 basename）。 */
  createWorkspaceByPath: (path: string) =>
    postJson<ClearResp>('/api/workspaces', { path }),
  /** 重命名工作区（W243）：POST /api/workspaces/{name}/rename {"new_name"}。 */
  renameWorkspace: (name: string, newName: string) =>
    postJson<ClearResp>('/api/workspaces/' + encodeURIComponent(name) + '/rename', {
      new_name: newName,
    }),
  deleteWorkspace: (name: string) =>
    postJson<ClearResp>('/api/workspaces/' + encodeURIComponent(name) + '/delete', {}),
  batchDeleteWorkspaces: (names: string[]) =>
    postJson<ClearResp>('/api/workspaces/batch-delete', { names } as BatchNamesReq),
  createSession: (req: SessionCreateReq) => postJson<SessionCreateResp>('/api/sessions', req),
  /** 重命名会话（W243）：POST /api/sessions/{id}/rename {"new_title"}。 */
  renameSession: (id: string, newTitle: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/rename', {
      new_title: newTitle,
    }),
  /** 分支会话（W243）：POST /api/sessions/{id}/branch {"title"?}。 */
  branchSession: (id: string, title?: string) =>
    postJson<ClearResp & { id?: string; branch?: string }>(
      '/api/sessions/' + encodeURIComponent(id) + '/branch',
      title ? { title } : {},
    ),
  archiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/archive', {}),
  unarchiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/unarchive', {}),
  /** 激活会话（W237）：POST /api/sessions/{id}/activate；409=轮次中。 */
  activateSession: (id: string) =>
    postJson<ActivateResp>('/api/sessions/' + encodeURIComponent(id) + '/activate', {}),
  /** 上下文压缩（W259）：POST /api/sessions/{id}/compact；409=turn 进行中。 */
  compactSession: (id: string) =>
    postJson<CompactResp>('/api/sessions/' + encodeURIComponent(id) + '/compact', {}),
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
  // ---- 提示词（W245；缺失时 404 优雅降级） ----
  // P0-4 scope 契约：不传 workspace=全局（后端默认 scope）；workspace=名=该工作区。
  prompts: (workspace?: string) =>
    requestJson<PromptsResp>(
      '/api/prompts' + (workspace ? '?workspace=' + encodeURIComponent(workspace) : ''),
    ),
  /** POST /api/prompts upsert：workspace 省略=全局；成功响应带 hot_applied。 */
  savePrompt: (payload: PromptUpsertReq) =>
    postJson<ClearResp & { hot_applied?: boolean }>('/api/prompts', payload),
  deletePrompt: (id: string, workspace?: string) =>
    postJson<ClearResp & { hot_applied?: boolean }>(
      '/api/prompts/' + encodeURIComponent(id) + '/delete',
      workspace ? { workspace } : {},
    ),
  setDefaultPrompt: (id: string, workspace?: string) =>
    postJson<ClearResp & { hot_applied?: boolean }>(
      '/api/prompts/' + encodeURIComponent(id) + '/default',
      workspace ? { workspace } : {},
    ),
};
