// ============================================================================
// ui/sessions.ts — 左侧工作区/会话树（W243 重构）：
//   结构自上而下：新会话按钮 → 工具行（搜索 / 排序 / 新建工作区）→ 分割线
//   → 会话树（工作区节点可折叠：文件夹图标+名称+「⋯」；会话叶子：文件图标
//    +标题+「⋯」）→ 引擎 Worker 组（W239，未就绪隐藏）。
//   工作区「⋯」菜单（锚定右下）：重命名 / 删除（确认后注销）/ 批量删除会话
//   （进入勾选模式：叶子左侧勾选框 + 底部操作条，走 batch-delete）。
//   会话「⋯」菜单：重命名 / 删除 / 归档 / 分支（成功后刷新并高亮新分支）。
//   搜索过滤工作区与会话；排序切换「最近活跃（modified）/ 名称」。
//   点击会话行 = 激活切换聊天区（第 4 轮契约）；活跃会话高亮。
//   图标：内联 SVG（不引图标库）。端点缺失（W243 并行开发）优雅降级。
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
let searchQuery = '';
let sortMode: 'active' | 'name' = 'active';
let workerTimer: number | null = null;
let searchTimer: number | null = null;

const WORKER_POLL_MS = 5000;

function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

function wsNameOf(s: SessionInfo): string {
  const ws = (s.workspace ?? '').trim();
  return ws === '' ? 'root' : ws;
}

/** 激活高亮只切 class（不重建树，避免闪烁）。 */
function updateActiveHighlight(container: HTMLElement): void {
  for (const n of container.querySelectorAll<HTMLElement>('.sess-leaf')) {
    n.classList.toggle('active', n.dataset.id === activeSession);
  }
}

function truncateName(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

// ---- 内联 SVG 图标 -----------------------------------------------------------------

type IconKind = 'folder' | 'file' | 'search' | 'sort' | 'folder-plus' | 'plus';

function svgIcon(kind: IconKind): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  switch (kind) {
    case 'folder':
      p.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z');
      break;
    case 'file':
      p.setAttribute('d', 'M3 1.5h6l4 4v9h-10zM9 1.5v4h4');
      break;
    case 'search':
      p.setAttribute('d', 'M6.5 11.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM14.5 14.5l-3.8-3.8');
      break;
    case 'sort':
      p.setAttribute('d', 'M2 4h12M5 8h7M8 12h4');
      break;
    case 'folder-plus':
      p.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v4M1.5 3.5v8a1 1 0 0 0 1 1h5.5M11 9v5M8.5 11.5h5');
      break;
    case 'plus':
      p.setAttribute('d', 'M8 3v10M3 8h10');
      break;
  }
  svg.appendChild(p);
  return svg;
}

// ---- 批量勾选模式 -------------------------------------------------------------------

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
  bar.querySelector('.sess-batchbar-count')!.textContent = '已选 ' + selected.size + ' 个会话';
  bar.classList.toggle('active', selected.size > 0);
}

async function batchDelete(container: HTMLElement): Promise<void> {
  const ids = Array.from(selected);
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: '批量删除',
    message: '将批量删除 ' + ids.length + ' 个会话。删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.batchDeleteSessions(ids);
    exitBatch(container);
  } catch (err) {
    note('批量删除失败：' + (err instanceof Error ? err.message : String(err)));
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
  const x = Math.max(0, Math.min(anchor.right - cr.left - 8, container.clientWidth - 180));
  const y = Math.max(0, Math.min(anchor.bottom - cr.top + 2, container.clientHeight - 60));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}

function closeCtxMenu(): void {
  for (const n of document.querySelectorAll('.sess-menu')) n.remove();
}

// ---- 会话 / 工作区操作 -----------------------------------------------------------------

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
    switchToSession(activeSession); // 离屏双缓冲：无空白帧
    updateActiveHighlight(container); // 只切 class，不重建整棵树
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) note('轮次进行中，请稍后重试');
    else note('激活失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function archiveSession(container: HTMLElement, id: string): Promise<void> {
  const ok = await confirmDialog({ title: '归档会话', message: '确认归档会话「' + id + '」？', okLabel: '归档' });
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

async function renameSession(container: HTMLElement, id: string, current: string): Promise<void> {
  const name = window.prompt('重命名会话（新标题）', current);
  if (name === null) return;
  const t = name.trim();
  if (t === '' || t === current) return;
  try {
    await api.renameSession(id, t);
    void loadTreeInto(container, null);
  } catch (err) {
    note('重命名失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function branchSession(container: HTMLElement, id: string): Promise<void> {
  const t = window.prompt('分支会话（新分支标题，可留空）', '');
  if (t === null) return;
  try {
    const r = await api.branchSession(id, t.trim() === '' ? undefined : t.trim());
    if (r.ok === false) {
      note('分支失败：' + (r.error || '—'));
      return;
    }
    const newId = r.id ?? r.branch;
    if (newId) S.selSession = newId; // 高亮新分支
    note('已创建分支' + (newId ? '：' + newId : ''));
    void loadTreeInto(container, null);
  } catch (err) {
    note('分支失败：' + (err instanceof Error ? err.message : String(err)));
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
    note('工作区已删除：' + name);
    void loadTreeInto(container, null);
  } catch (err) {
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function renameWorkspace(container: HTMLElement, name: string): Promise<void> {
  const n = window.prompt('重命名工作区', name);
  if (n === null) return;
  const t = n.trim();
  if (t === '' || t === name) return;
  try {
    await api.renameWorkspace(name, t);
    void loadTreeInto(container, null);
  } catch (err) {
    note('重命名失败：' + (err instanceof Error ? err.message : String(err)));
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

// ---- 渲染：工具行 + 树 ------------------------------------------------------------------

function renderToolbar(container: HTMLElement): void {
  // 新会话按钮（树顶部）
  const nsBtn = el('button', 'btn btn-soft ws-newsess') as HTMLButtonElement;
  nsBtn.type = 'button';
  nsBtn.appendChild(svgIcon('plus'));
  nsBtn.appendChild(el('span', null, '新会话'));
  nsBtn.addEventListener('click', () => newSession());
  container.appendChild(nsBtn);

  // 工具行：搜索 / 排序 / 新建工作区
  const row = el('div', 'ws-toolrow');
  const searchBox = el('div', 'ws-search');
  searchBox.appendChild(svgIcon('search'));
  const input = el('input', 'ws-search-input') as HTMLInputElement;
  input.placeholder = '搜索工作区/会话';
  input.value = searchQuery;
  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase();
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadTreeInto(container, null), 180);
  });
  searchBox.appendChild(input);
  row.appendChild(searchBox);

  const sortBtn = el('button', 'ws-toolbtn') as HTMLButtonElement;
  sortBtn.type = 'button';
  sortBtn.appendChild(svgIcon('sort'));
  sortBtn.appendChild(el('span', 'ws-toolbtn-label', sortMode === 'active' ? '活跃' : '名称'));
  sortBtn.title = '排序：' + (sortMode === 'active' ? '最近活跃（modified）' : '名称') + ' · 点击切换';
  sortBtn.addEventListener('click', () => {
    sortMode = sortMode === 'active' ? 'name' : 'active';
    void loadTreeInto(container, null);
  });
  row.appendChild(sortBtn);

  const wsBtn = el('button', 'ws-toolbtn') as HTMLButtonElement;
  wsBtn.type = 'button';
  wsBtn.title = '新建工作区';
  wsBtn.appendChild(svgIcon('folder-plus'));
  wsBtn.addEventListener('click', newWorkspace);
  row.appendChild(wsBtn);

  container.appendChild(row);
  container.appendChild(el('div', 'ws-divider'));
}

function matchesQuery(text: string): boolean {
  return searchQuery === '' || text.toLowerCase().includes(searchQuery);
}

function sortSessions(list: SessionInfo[]): SessionInfo[] {
  const arr = [...list];
  if (sortMode === 'name') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    return arr;
  }
  // 最近活跃：modified 降序，无 modified 排后
  arr.sort((a, b) => {
    const am = typeof a.modified === 'number' ? a.modified : -1;
    const bm = typeof b.modified === 'number' ? b.modified : -1;
    return bm - am;
  });
  return arr;
}

function renderLeaf(container: HTMLElement, s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const isActive = id === activeSession;
  const leaf = el('div', 'sess-leaf' + (isActive ? ' active' : '') + (S.selSession === id ? ' sel' : ''));
  leaf.dataset.id = id;

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
    leaf.appendChild(cb);
  }
  leaf.appendChild(svgIcon('file'));
  const name = el('span', 'sess-leaf-name', s.title || truncateName(id) || '(未命名)');
  leaf.appendChild(name);
  const bits: string[] = [];
  if (s.events !== undefined) bits.push('ev:' + s.events);
  bits.push(truncateName(id));
  leaf.appendChild(el('span', 'sess-leaf-meta', bits.join(' · ')));
  leaf.title = id + (s.file ? ' · ' + s.file : '');

  if (!batchMode) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = '会话操作';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(container, kebab.getBoundingClientRect(), [
        { label: isActive ? '当前活跃' : '激活', disabled: isActive, onPick: () => void activateSession(container, id) },
        { label: '重命名', onPick: () => void renameSession(container, id, s.title || truncateName(id)) },
        { label: '归档', onPick: () => void archiveSession(container, id) },
        { label: '分支', onPick: () => void branchSession(container, id) },
        { label: '删除', danger: true, onPick: () => void deleteSession(container, id) },
      ]);
    });
    leaf.appendChild(kebab);
  }
  leaf.addEventListener('click', () => {
    void activateSession(container, id);
  });
  return leaf;
}

function renderWorkspaceNode(container: HTMLElement, name: string, list: SessionInfo[]): HTMLElement {
  const wrap = el('div', 'ws-node');
  const det = document.createElement('details');
  det.className = 'ws-details';
  det.dataset.ws = name;
  det.open = true;
  const sum = document.createElement('summary');
  sum.className = 'ws-head';
  sum.appendChild(svgIcon('folder'));
  sum.appendChild(el('span', 'ws-name', name));
  sum.appendChild(el('span', 'ws-count', String(list.length)));
  const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
  kebab.type = 'button';
  kebab.title = '工作区操作';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    openCtxMenu(container, kebab.getBoundingClientRect(), [
      { label: '重命名', onPick: () => void renameWorkspace(container, name) },
      {
        label: '批量删除会话',
        onPick: () => {
          batchMode = true;
          selected.clear();
          void loadTreeInto(container, null);
        },
      },
      { label: '删除工作区', danger: true, onPick: () => void deleteWorkspace(container, name) },
    ]);
  });
  sum.appendChild(kebab);
  det.appendChild(sum);
  const body = el('div', 'ws-body');
  for (const s of sortSessions(list)) body.appendChild(renderLeaf(container, s));
  det.appendChild(body);
  wrap.appendChild(det);
  return wrap;
}

function renderBatchBar(container: HTMLElement): void {
  const bar = el('div', 'sess-batchbar');
  bar.appendChild(el('span', 'sess-batchbar-count', '已选 0 个会话'));
  const del = el('button', 'btn btn-danger btn-mini', '删除选中') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => void batchDelete(container));
  const quit = el('button', 'btn-mini', '取消') as HTMLButtonElement;
  quit.type = 'button';
  quit.addEventListener('click', () => exitBatch(container));
  bar.appendChild(del);
  bar.appendChild(quit);
  container.appendChild(bar);
}

// ---- 引擎 Worker 组（W239） -----------------------------------------------------------

function workerSessions(list: SessionInfo[]): SessionInfo[] {
  return list.filter((s) => s.kind === 'worker' || (s.id ?? '').startsWith('worker:'));
}

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
  container.querySelector('.ws-worker-group')?.remove();
  if (workers.length) renderWorkerGroup(container, workers);
}

function ensureWorkerPoll(container: HTMLElement): void {
  if (workerTimer !== null) return;
  workerTimer = window.setInterval(() => {
    void refreshWorkers(container);
  }, WORKER_POLL_MS);
}

function stopWorkerPoll(): void {
  if (workerTimer !== null) {
    window.clearInterval(workerTimer);
    workerTimer = null;
  }
}

// ---- 新建入口 -------------------------------------------------------------------------

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
    if (!parts.length) crumbs.appendChild(el('span', 'ws-fs-crumb cur', '/'));
  }

  async function loadDirs(path: string): Promise<void> {
    // 第 11 轮：目录跳转双缓冲——旧目录列表保留到新列表就绪，一次替换
    status.className = 'ws-fs-status';
    status.textContent = '加载中…';
    let r;
    try {
      r = await api.fsBrowse(path);
    } catch (err) {
      status.className = 'ws-fs-status err';
      status.textContent = '文件浏览暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）· 请直接在下方输入路径';
      const off = document.createElement('div');
      off.appendChild(el('div', 'side-note', '可编辑底部路径后点「跳转」，或直接填写名称+路径创建'));
      tree.replaceChildren(...off.childNodes);
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
    const off = document.createElement('div');
    const dirs = r.dirs ?? [];
    if (!dirs.length) off.appendChild(el('div', 'side-note', '（该目录下没有子目录）'));
    for (const d of dirs) {
      const row = el('div', 'ws-fs-dir');
      row.appendChild(el('span', 'ws-fs-dir-icon', '▸'));
      row.appendChild(el('span', 'ws-fs-dir-name', d));
      row.addEventListener('click', () => {
        const next = (curPath ? curPath.replace(/\/+$/, '') : '') + '/' + d;
        void loadDirs(next);
      });
      off.appendChild(row);
    }
    tree.replaceChildren(...off.childNodes);
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
  void loadDirs('');
}

// ---- 树渲染主流程 ----------------------------------------------------------------------

/** 载入并渲染：新会话按钮 + 工具行 + 工作区/会话树 + Worker 组（侧栏与设置页复用）。 */
export async function loadTreeInto(container: HTMLElement, countEl: HTMLElement | null): Promise<void> {
  closeCtxMenu();
  // 记录折叠状态与搜索框焦点（重建后保持，避免闪动）
  const openMap = new Map<string, boolean>();
  for (const det of container.querySelectorAll<HTMLDetailsElement>('.ws-details')) {
    openMap.set(det.dataset.ws ?? '', det.open);
  }
  const searchFocused = document.activeElement?.classList.contains('ws-search-input') ?? false;
  const off = document.createElement('div'); // 离屏容器：构建期间旧内容保持可见
  if (countEl) countEl.textContent = '…';

  try {
    const w = await api.workspaces();
    wsList = w.workspaces ?? [];
    if (w.active_session) activeSession = w.active_session;
  } catch {
    wsList = [];
  }

  try {
    const d = await api.sessions();
    sessions = d.sessions ?? [];
    const act = (d.sessions ?? []).find((s) => s.active === true);
    if (act?.id) activeSession = act.id;
  } catch (err) {
    stopWorkerPoll();
    off.appendChild(el('div', 'side-note err', '会话接口不可用'));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    container.replaceChildren(...off.childNodes);
    if (countEl) countEl.textContent = '—';
    return;
  }

  const wsNames = new Set<string>();
  for (const s of sessions) if (!s.archived) wsNames.add(wsNameOf(s));
  for (const n of wsNames) {
    if (!wsList.some((w) => w.name === n)) wsList.push({ name: n });
  }
  wsList.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (countEl) countEl.textContent = String(sessions.filter((s) => s.archived !== true).length);

  renderToolbar(off);

  // 树：按工作区收束（可折叠）
  const tree = el('div', 'ws-tree');
  const wsWith = wsList.filter(
    (w) =>
      matchesQuery(w.name) ||
      sessions.some((s) => !s.archived && wsNameOf(s) === w.name && matchesQuery(s.title ?? s.id ?? '')),
  );
  let rendered = 0;
  for (const w of wsWith) {
    const list = sessions.filter(
      (s) => !s.archived && wsNameOf(s) === w.name && matchesQuery(s.title ?? s.id ?? ''),
    );
    if (!matchesQuery(w.name) && !list.length) continue;
    tree.appendChild(renderWorkspaceNode(container, w.name, list));
    rendered += list.length;
  }
  if (!rendered) {
    tree.appendChild(el('div', 'side-note', searchQuery ? '无匹配结果' : '无会话记录 · 点击「新会话」创建'));
  }
  off.appendChild(tree);

  // 批量勾选模式：底部操作条
  if (batchMode) renderBatchBar(off);

  // 引擎 Worker 组
  const workers = workerSessions(sessions);
  if (workers.length) {
    renderWorkerGroup(off, workers);
    ensureWorkerPoll(container);
  } else {
    stopWorkerPoll();
  }

  // 一次性替换（无空白帧）
  container.replaceChildren(...off.childNodes);

  // 恢复折叠状态
  for (const det of container.querySelectorAll<HTMLDetailsElement>('.ws-details')) {
    const name = det.dataset.ws ?? '';
    if (openMap.has(name)) det.open = openMap.get(name) ?? true;
  }
  // 恢复搜索框焦点（输入过滤时不丢焦点）
  if (searchFocused) {
    const inp = container.querySelector<HTMLInputElement>('.ws-search-input');
    if (inp) inp.focus();
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
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.sess-menu')) closeCtxMenu();
  });
  void loadSessions();
}
