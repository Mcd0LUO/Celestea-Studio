// ============================================================================
// ui/sessions.ts — 左侧「工作区/会话」面板（W237 契约，端点缺失优雅降级）：
//   顶部工作区横向胶囊条（可横向滚动；胶囊「⋯」菜单就地锚定右下）：
//     删除工作区（仅注销）/ 新建会话 / 清空（活跃会话在本工作区时可用）/
//     批量操作（复选批量归档/删除）
//   下方 = 当前工作区的会话纵向列表；会话行「⋯」菜单：激活 / 归档 / 删除。
//   点击会话行 = 激活（POST /api/sessions/{id}/activate，409=轮次中提示）→
//   成功切换聊天区为该会话（restore.switchToSession 拉取历史渲染）。
//   活跃会话高亮（GET /api/sessions 的 active 字段 / GET /api/workspaces 的
//   active_session）。无「主会话/cli-main 置顶」特设逻辑。
//   新建工作区 = 文件管理器弹窗（GET /api/fs/browse 懒加载，面包屑/目录树/
//   地址栏；接口缺失降级为手输路径）。
// ============================================================================
import { api, ApiError } from '../api';
import { el, need } from '../utils/dom';
import type { SessionInfo, WorkspaceInfo } from '../types';
import { S } from '../state';
import { resetMessages } from './messages';
import { switchToSession } from './restore';
import { confirmDialog } from './confirm';

// ---- 面板状态 ---------------------------------------------------------------------

let batchMode = false;
const selected = new Set<string>();

let wsList: WorkspaceInfo[] = [];
let sessions: SessionInfo[] = [];
let activeSession: string | null = null;
let selectedWs: string | null = null;
let workerTimer: number | null = null; // 引擎 Worker 组轮询

const WORKER_POLL_MS = 5000;

function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

function wsNameOf(s: SessionInfo): string {
  const ws = (s.workspace ?? '').trim();
  return ws === '' ? 'root' : ws;
}

/** 活跃会话所在工作区（优先当前选中的）。 */
function pickSelectedWs(): string | null {
  if (selectedWs !== null && wsList.some((w) => w.name === selectedWs)) return selectedWs;
  const act = sessions.find((s) => s.id === activeSession);
  if (act) return wsNameOf(act);
  if (wsList.length) return wsList[0]!.name;
  return null;
}

function currentWsSessions(): SessionInfo[] {
  return sessions.filter((s) => !s.archived && wsNameOf(s) === selectedWs);
}

/** 引擎 Worker 条目（W239：kind="worker"、workspace="engine"、id 形如 "worker:<sid>"）。 */
function workerSessions(list: SessionInfo[]): SessionInfo[] {
  return list.filter(
    (s) => s.kind === 'worker' || (s.id ?? '').startsWith('worker:'),
  );
}

// ---- 批量模式 ----------------------------------------------------------------------

function exitBatch(container: HTMLElement): void {
  batchMode = false;
  selected.clear();
  void loadTreeInto(container, null);
}

function refreshChecks(container: HTMLElement): void {
  for (const cb of container.querySelectorAll<HTMLInputElement>('.sess-check')) {
    cb.checked = cb.dataset.id !== undefined && selected.has(cb.dataset.id);
  }
  const bar = container.querySelector<HTMLElement>('.sess-batchbar');
  if (!bar) return;
  bar.querySelector('.sess-batchbar-count')!.textContent = '已选 ' + selected.size;
  bar.classList.toggle('active', selected.size > 0);
}

async function batchAction(container: HTMLElement, action: 'archive' | 'delete'): Promise<void> {
  const ids = Array.from(selected);
  if (!ids.length) return;
  const ok = await confirmDialog(
    action === 'delete'
      ? {
          title: '批量删除',
          message: '将批量删除 ' + ids.length + ' 个会话。删除后可在回收目录恢复，确认？',
          okLabel: '批量删除',
          danger: true,
        }
      : {
          title: '批量归档',
          message: '确认归档 ' + ids.length + ' 个会话？',
          okLabel: '批量归档',
        },
  );
  if (!ok) return;
  try {
    if (action === 'archive') await api.batchArchiveSessions(ids);
    else await api.batchDeleteSessions(ids);
    exitBatch(container);
  } catch (err) {
    note('批量' + (action === 'archive' ? '归档' : '删除') + '失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---- 菜单浮层（锚定触发按钮右下） ----------------------------------------------------

interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
}

function openCtxMenu(container: HTMLElement, anchor: DOMRect, items: MenuItem[]): void {
  closeCtxMenu();
  const cr = container.getBoundingClientRect();
  const m = el('div', 'sess-menu');
  for (const it of items) {
    const b = el('button', 'sess-menu-item' + (it.danger ? ' danger' : ''), it.label) as HTMLButtonElement;
    b.type = 'button';
    if (it.disabled) {
      b.disabled = true;
      b.classList.add('disabled');
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCtxMenu();
      it.onPick();
    });
    m.appendChild(b);
  }
  container.appendChild(m);
  // 就近弹出：锚定按钮右下，防溢出容器
  const x = Math.max(0, Math.min(anchor.right - cr.left - 8, container.clientWidth - 180));
  const y = Math.max(0, Math.min(anchor.bottom - cr.top + 2, container.clientHeight - 60));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}

function closeCtxMenu(): void {
  for (const n of document.querySelectorAll('.sess-menu')) n.remove();
}

// ---- 操作 --------------------------------------------------------------------------

async function activateSession(container: HTMLElement, id: string): Promise<void> {
  if (id === activeSession) return;
  try {
    const r = await api.activateSession(id);
    if (r.ok === false) {
      note('激活失败：' + (r.error || '—'));
      return;
    }
    activeSession = r.active_session ?? id;
    S.selSession = activeSession;
    note('已切换到会话：' + activeSession);
    switchToSession(activeSession); // 聊天区切换为该会话历史
    void loadTreeInto(container, null);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      note('轮次进行中，请稍后重试');
    } else {
      note('激活失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }
}

async function archiveSession(container: HTMLElement, id: string): Promise<void> {
  const ok = await confirmDialog({
    title: '归档会话',
    message: '确认归档会话「' + id + '」？',
    okLabel: '归档',
  });
  if (!ok) return;
  try {
    await api.archiveSession(id);
    void loadTreeInto(container, null);
  } catch (err) {
    note('归档失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function deleteSession(container: HTMLElement, id: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除会话「' + id + '」',
    message: '删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.batchDeleteSessions([id]);
    void loadTreeInto(container, null);
  } catch (err) {
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function deleteWorkspace(container: HTMLElement, name: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除工作区「' + name + '」',
    message: '删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteWorkspace(name);
    note('工作区已注销：' + name);
    void loadTreeInto(container, null);
  } catch (err) {
    note('注销失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/** 清空活跃会话（POST /api/clear；二次确认，默认焦点在取消）。 */
function clearActive(): void {
  void confirmDialog({
    title: '清空当前会话',
    message: '将清空当前会话全部消息，且不可恢复。确认清空？',
    okLabel: '清空',
    danger: true,
  }).then((ok) => {
    if (!ok) return;
    void api
      .clear()
      .then((d) => {
        if (d.ok) {
          note('当前会话已清空');
          resetMessages();
          S.assistant = null;
          S.turn = null;
        } else {
          note('清空失败（返回异常）');
        }
      })
      .catch((err: unknown) => {
        note('清空失败：' + (err instanceof Error ? err.message : String(err)));
      });
  });
}

// ---- 渲染：工作区胶囊条 + 会话列表 ----------------------------------------------------

function renderPill(container: HTMLElement, w: WorkspaceInfo): HTMLElement {
  const pill = el('div', 'ws-pill' + (w.name === selectedWs ? ' active' : ''));
  if (activeSession !== null) {
    const act = sessions.find((s) => s.id === activeSession);
    if (act && wsNameOf(act) === w.name) pill.classList.add('has-active');
  }
  pill.appendChild(el('span', 'ws-pill-name', w.name));
  const cnt = sessions.filter((s) => !s.archived && wsNameOf(s) === w.name).length;
  pill.appendChild(el('span', 'ws-pill-count', String(cnt)));
  const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
  kebab.type = 'button';
  kebab.title = '工作区操作';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = sessions.find((s) => s.id === activeSession);
    const inWs = activeSession !== null && act !== undefined && wsNameOf(act) === w.name;
    openCtxMenu(container, kebab.getBoundingClientRect(), [
      { label: '新建会话', onPick: () => newSession(w.name) },
      {
        label: '清空（活跃会话）',
        disabled: !inWs,
        onPick: () => {
          if (inWs) clearActive();
        },
      },
      { label: '批量操作会话', onPick: () => { batchMode = true; selected.clear(); void loadTreeInto(container, null); } },
      { label: '删除工作区（仅注销）', danger: true, onPick: () => void deleteWorkspace(container, w.name) },
    ]);
  });
  pill.appendChild(kebab);
  pill.addEventListener('click', (e) => {
    if (e.target === kebab) return;
    selectedWs = w.name;
    void loadTreeInto(container, null);
  });
  return pill;
}

function renderSessionRow(container: HTMLElement, s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const isActive = id === activeSession;
  const row = el('div', 'sess-row' + (isActive ? ' active' : '') + (S.selSession === id ? ' sel' : ''));
  row.dataset.id = id;

  if (batchMode) {
    const cb = el('input', 'sess-check') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.dataset.id = id;
    cb.checked = selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      refreshChecks(container);
    });
    row.appendChild(cb);
  }
  row.appendChild(el('span', 'sess-dot' + (isActive ? ' live' : '')));
  const name = el('span', 'sess-row-name', s.title || truncateName(id) || '(未命名)');
  row.appendChild(name);
  const bits: string[] = [];
  if (s.events !== undefined) bits.push('ev:' + s.events);
  bits.push(truncateName(id));
  row.appendChild(el('span', 'sess-row-meta', bits.join(' · ')));
  row.title = id + (s.file ? ' · ' + s.file : '');

  if (!batchMode) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = '会话操作';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(container, kebab.getBoundingClientRect(), [
        { label: isActive ? '当前活跃' : '激活', disabled: isActive, onPick: () => void activateSession(container, id) },
        { label: '归档', onPick: () => void archiveSession(container, id) },
        { label: '删除', danger: true, onPick: () => void deleteSession(container, id) },
      ]);
    });
    row.appendChild(kebab);
  }
  // 点击行 = 激活该会话（切换聊天区）
  row.addEventListener('click', () => {
    void activateSession(container, id);
  });
  return row;
}

function truncateName(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

// ---- 引擎 Worker 组 ------------------------------------------------------------------

function renderWorkerGroup(container: HTMLElement, workers: SessionInfo[]): void {
  const group = el('div', 'ws-worker-group');
  const head = el('div', 'ws-worker-head');
  head.appendChild(el('span', null, '引擎 Worker'));
  head.appendChild(el('span', 'ws-worker-count', String(workers.length)));
  group.appendChild(head);
  for (const w of workers) {
    const id = w.id ?? '';
    const row = el('div', 'ws-worker-row' + (S.selSession === id ? ' active' : ''));
    row.dataset.id = id;
    row.appendChild(el('span', 'sess-dot live'));
    const name = el('span', 'ws-worker-name', w.title || truncateName(id) || id);
    row.appendChild(name);
    const bits: string[] = [];
    if (w.model) bits.push(String(w.model));
    if (w.events !== undefined) bits.push('ev:' + w.events);
    row.appendChild(el('span', 'ws-worker-meta', bits.join(' · ')));
    row.title = id + (w.model ? ' · ' + w.model : '');
    // 点击仅选中高亮（延续 W230 决策，不切换聊天区）
    row.addEventListener('click', () => {
      S.selSession = id;
      for (const n of container.querySelectorAll<HTMLElement>('.ws-worker-row')) {
        n.classList.toggle('active', n.dataset.id === id);
      }
    });
    group.appendChild(row);
  }
  container.appendChild(group);
}

/** 轮询刷新引擎 Worker 组（worker 状态会变；仅重渲染该组）。 */
async function refreshWorkers(container: HTMLElement): Promise<void> {
  if (!container.isConnected) return;
  let list: SessionInfo[];
  try {
    const d = await api.sessions();
    list = d.sessions ?? [];
  } catch {
    return;
  }
  const workers = workerSessions(list);
  const old = container.querySelector<HTMLElement>('.ws-worker-group');
  if (!workers.length) {
    old?.remove();
    return;
  }
  if (old) {
    old.remove();
    renderWorkerGroup(container, workers);
  } else {
    renderWorkerGroup(container, workers);
  }
}

function stopWorkerPoll(): void {
  if (workerTimer !== null) {
    window.clearInterval(workerTimer);
    workerTimer = null;
  }
}

/** 若列表含 worker 条目则启动轮询（幂等）。 */
function ensureWorkerPoll(container: HTMLElement): void {
  if (workerTimer !== null) return;
  workerTimer = window.setInterval(() => {
    void refreshWorkers(container);
  }, WORKER_POLL_MS);
}

// ---- 新建入口 -----------------------------------------------------------------------

/** 新建会话弹窗：标题 + 选择工作区（presetWs 预选）。 */
export function newSession(presetWs?: string): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card');
  card.appendChild(el('div', 'modal-card-title', '新建会话'));
  const titleInput = el('input', 'cfg-input') as HTMLInputElement;
  titleInput.placeholder = '会话标题';
  card.appendChild(titleInput);
  const wsSel = document.createElement('select');
  wsSel.className = 'cfg-input';
  const optRoot = document.createElement('option');
  optRoot.value = '';
  optRoot.textContent = 'root（默认工作区）';
  wsSel.appendChild(optRoot);
  for (const w of wsList) {
    const o = document.createElement('option');
    o.value = w.name;
    o.textContent = w.name;
    wsSel.appendChild(o);
  }
  if (presetWs) wsSel.value = presetWs;
  card.appendChild(wsSel);
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const create = el('button', 'btn btn-accent', '创建') as HTMLButtonElement;
  create.type = 'button';
  const close = () => scrim.remove();
  cancel.addEventListener('click', close);
  create.addEventListener('click', () => {
    const t = titleInput.value.trim();
    if (!t) {
      titleInput.focus();
      return;
    }
    const ws = wsSel.value === '' ? null : wsSel.value;
    create.disabled = true;
    create.textContent = '创建中…';
    void api
      .createSession({ workspace: ws, title: t })
      .then(() => {
        note('会话已创建：' + t);
        close();
        void loadSessions();
      })
      .catch((err: unknown) => {
        note('创建会话失败：' + (err instanceof Error ? err.message : String(err)));
        create.disabled = false;
        create.textContent = '创建';
      });
  });
  actions.appendChild(cancel);
  actions.appendChild(create);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  titleInput.focus();
}

/** 新建工作区：文件管理器弹窗（fs/browse 懒加载；缺失降级手输路径）。 */
export function newWorkspace(): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card ws-fs');
  card.appendChild(el('div', 'modal-card-title', '新建工作区'));

  let curPath = '';

  const crumbs = el('div', 'ws-fs-crumbs');
  const tree = el('div', 'ws-fs-tree');
  const addrRow = el('div', 'ws-fs-addr');
  const addrInput = el('input', 'cfg-input') as HTMLInputElement;
  addrInput.placeholder = '目录路径（可编辑后跳转）';
  addrInput.value = '';
  const goBtn = el('button', 'btn btn-soft btn-mini', '跳转') as HTMLButtonElement;
  goBtn.type = 'button';
  addrRow.appendChild(addrInput);
  addrRow.appendChild(goBtn);

  const nameRow = el('div', 'ws-fs-name');
  const nameInput = el('input', 'cfg-input') as HTMLInputElement;
  nameInput.placeholder = '工作区名称（字母/数字/下划线）';
  nameRow.appendChild(nameInput);

  const status = el('div', 'ws-fs-status');
  card.appendChild(crumbs);
  card.appendChild(tree);
  card.appendChild(addrRow);
  card.appendChild(nameRow);
  card.appendChild(status);

  function renderCrumbs(roots: string[], path: string): void {
    crumbs.innerHTML = '';
    if (roots.length) {
      for (const r of roots) {
        const b = el('button', 'ws-fs-crumb root', r) as HTMLButtonElement;
        b.type = 'button';
        b.addEventListener('click', () => void loadDirs(r));
        crumbs.appendChild(b);
      }
      crumbs.appendChild(el('span', 'ws-fs-crumb-sep', '·'));
    }
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      acc += '/' + seg;
      const b = el('button', 'ws-fs-crumb' + (i === parts.length - 1 ? ' cur' : ''), seg) as HTMLButtonElement;
      b.type = 'button';
      const target = acc;
      b.addEventListener('click', () => void loadDirs(target));
      crumbs.appendChild(b);
    }
    if (!parts.length) {
      crumbs.appendChild(el('span', 'ws-fs-crumb cur', '/'));
    }
  }

  async function loadDirs(path: string): Promise<void> {
    status.className = 'ws-fs-status';
    status.textContent = '加载中…';
    tree.innerHTML = '<div class="side-note">加载中…</div>';
    let r;
    try {
      r = await api.fsBrowse(path);
    } catch (err) {
      // 降级：fs 接口不可用 → 手输路径模式
      status.className = 'ws-fs-status err';
      status.textContent = '文件浏览暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）· 请直接在下方输入路径';
      tree.innerHTML = '';
      tree.appendChild(el('div', 'side-note', '可编辑底部路径后点「跳转」，或直接填写名称+路径创建'));
      addrInput.value = path;
      curPath = path;
      return;
    }
    if (r.error) {
      status.className = 'ws-fs-status err';
      status.textContent = '浏览失败：' + r.error;
    } else {
      status.textContent = '已选择目录：' + (r.path || '/');
      status.className = 'ws-fs-status ok';
    }
    curPath = r.path ?? path;
    addrInput.value = r.path ?? path;
    renderCrumbs(r.roots ?? [], r.path ?? path);
    tree.innerHTML = '';
    const dirs = r.dirs ?? [];
    if (!dirs.length) {
      tree.appendChild(el('div', 'side-note', '（该目录下没有子目录）'));
    }
    for (const d of dirs) {
      const row = el('div', 'ws-fs-dir');
      row.appendChild(el('span', 'ws-fs-dir-icon', '▸'));
      row.appendChild(el('span', 'ws-fs-dir-name', d));
      row.addEventListener('click', () => {
        const next = (curPath ? curPath.replace(/\/+$/, '') : '') + '/' + d;
        void loadDirs(next);
      });
      tree.appendChild(row);
    }
  }

  goBtn.addEventListener('click', () => {
    const p = addrInput.value.trim();
    if (p) void loadDirs(p);
  });
  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });

  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const create = el('button', 'btn btn-accent', '创建') as HTMLButtonElement;
  create.type = 'button';
  const close = () => scrim.remove();
  cancel.addEventListener('click', close);
  create.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    create.disabled = true;
    create.textContent = '创建中…';
    void api
      .createWorkspace(name, curPath || addrInput.value.trim() || undefined)
      .then(() => {
        note('工作区已创建：' + name);
        close();
        void loadSessions();
      })
      .catch((err: unknown) => {
        status.className = 'ws-fs-status err';
        status.textContent = '创建工作区失败：' + (err instanceof Error ? err.message : String(err));
        create.disabled = false;
        create.textContent = '创建';
      });
  });
  actions.appendChild(cancel);
  actions.appendChild(create);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  // 初始加载：根视图（roots）
  void loadDirs('');
}

// ---- 渲染主流程 ---------------------------------------------------------------------

function renderBatchBar(container: HTMLElement): void {
  const bar = el('div', 'sess-batchbar');
  bar.appendChild(el('span', 'sess-batchbar-count', '已选 0'));
  const arch = el('button', 'btn-mini', '批量归档') as HTMLButtonElement;
  arch.type = 'button';
  arch.addEventListener('click', () => void batchAction(container, 'archive'));
  const del = el('button', 'btn-mini danger', '批量删除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => void batchAction(container, 'delete'));
  const quit = el('button', 'btn-mini', '退出批量') as HTMLButtonElement;
  quit.type = 'button';
  quit.addEventListener('click', () => exitBatch(container));
  bar.appendChild(arch);
  bar.appendChild(del);
  bar.appendChild(quit);
  container.appendChild(bar);
}

/** 载入并渲染：工作区横向胶囊条 + 当前工作区会话列表（侧栏与设置页复用）。 */
export async function loadTreeInto(container: HTMLElement, countEl: HTMLElement | null): Promise<void> {
  closeCtxMenu();
  container.innerHTML = '';
  if (countEl) countEl.textContent = '…';

  try {
    const w = await api.workspaces();
    wsList = w.workspaces ?? [];
    if (w.active_session) activeSession = w.active_session;
  } catch {
    wsList = []; // 降级：仅按 sessions 的 workspace 分组
  }

  try {
    const d = await api.sessions();
    sessions = d.sessions ?? [];
    const act = (d.sessions ?? []).find((s) => s.active === true);
    if (act?.id) activeSession = act.id;
  } catch (err) {
    stopWorkerPoll();
    container.innerHTML = '';
    container.appendChild(el('div', 'side-note err', '会话接口不可用'));
    container.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    if (countEl) countEl.textContent = '—';
    return;
  }

  // 若 wsList 为空（workspaces 未就绪）：从 sessions 反推工作区
  const wsNames = new Set<string>();
  for (const s of sessions) if (!s.archived) wsNames.add(wsNameOf(s));
  for (const n of wsNames) {
    if (!wsList.some((w) => w.name === n)) wsList.push({ name: n });
  }
  wsList.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (countEl) countEl.textContent = String(sessions.filter((s) => s.archived !== true).length);

  selectedWs = pickSelectedWs();
  if (selectedWs === null) {
    container.appendChild(el('div', 'side-note', '无工作区 · 点击「+工作区」创建'));
    return;
  }

  // 1) 工作区胶囊条（横向滚动）
  const strip = el('div', 'ws-strip');
  for (const w of wsList) strip.appendChild(renderPill(container, w));
  container.appendChild(strip);

  // 2) 会话列表
  const listHead = el('div', 'sess-list-head');
  listHead.appendChild(el('span', 'sess-list-title', selectedWs));
  const listCount = currentWsSessions().length;
  listHead.appendChild(el('span', 'sess-list-count', String(listCount) + ' 会话'));
  container.appendChild(listHead);

  if (batchMode) renderBatchBar(container);

  const list = el('div', 'sess-list');
  const cur = currentWsSessions();
  cur.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
  if (!cur.length) {
    list.appendChild(el('div', 'side-note', '该工作区暂无会话'));
  }
  for (const s of cur) list.appendChild(renderSessionRow(container, s));
  container.appendChild(list);

  // 3) 引擎 Worker 组（W239；未就绪/无条目时整组隐藏，不轮询）
  const workers = workerSessions(sessions);
  if (workers.length) {
    renderWorkerGroup(container, workers);
    ensureWorkerPoll(container);
  } else {
    stopWorkerPoll();
  }
}

// ---- 装配 ------------------------------------------------------------------------

export function loadSessions(): Promise<void> {
  return loadTreeInto(need<HTMLElement>('#sessionTree'), need<HTMLElement>('#sessionCount'));
}

/** 清空当前活跃会话（侧栏与设置页「会话」页复用）。 */
export function clearCurrentSession(): void {
  clearActive();
}

export function initSessionsPanel(): void {
  need<HTMLButtonElement>('#btnReloadSessions').addEventListener('click', () => {
    void loadSessions();
  });
  need<HTMLButtonElement>('#btnClearSess').addEventListener('click', () => {
    clearActive();
  });
  need<HTMLButtonElement>('#btnNewWs').addEventListener('click', newWorkspace);
  need<HTMLButtonElement>('#btnNewSess').addEventListener('click', () => newSession());
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.sess-menu')) closeCtxMenu();
  });
  void loadSessions();
}
