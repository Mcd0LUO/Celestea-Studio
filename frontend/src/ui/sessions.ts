// ============================================================================
// ui/sessions.ts — 左侧工作区/会话树（W243 重构）：
//   结构自上而下：新会话按钮 → 工具行（搜索 / 排序 / 新建工作区）→ 分割线
//   → 会话树（工作区节点可折叠：文件夹图标+名称+「⋯」；会话叶子：文件图标
//    +标题+「⋯」）→ 引擎 Worker 组（W239，未就绪隐藏）。
//   工作区「⋯」菜单（锚定右下）：重命名 / 删除（确认后注销）/ 批量删除会话
//   （进入勾选模式：叶子左侧勾选框 + 底部操作条，走 batch-delete）。
//   会话「⋯」菜单：重命名 / 删除 / 归档 / 分支（成功后刷新并高亮新分支）。
//   搜索过滤工作区与会话；排序切换「最近活跃（modified）/ 名称」。
//   点击会话行 = **立即**打开该会话的视图容器（不因别的会话在跑而阻塞），
//   随后后台 POST activate（409/不可用只提示，视图照常可看）。
//   W514：Worker 组可展开（wid / 标题 / 运行状态 / 模型），点击打开其会话视图；
//         会话行显示运行态点，运行态变化只做局部 class 更新（铁律 6）。
//   图标：内联 SVG（不引图标库）。端点缺失（W243 并行开发）优雅降级。
// ============================================================================
import { api, ApiError } from '../api';
import { el, need } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { SessionInfo, WorkspaceInfo } from '../types';
import { S } from '../state';
import { openSession } from './restore';
import { activeSessionId, onBusyChange, paneBusy, setPaneMeta, setRemoteBusy } from './viewctx';
import { updateSessionBar } from './sessionbar';
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

/** W515：父会话 id → worker 子会话数（用于父会话行的「W n」徽标）。 */
let workersByParent = new Map<string, number>();

function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

/**
 * W515：谱系父会话 id（对齐 DSH 的 parentSessionId）。
 * 兼容 parent / parentSessionId / parent_session 三种写法；缺失 → null（平坦展示）。
 */
function parentOf(s: SessionInfo): string | null {
  const v = s.parentSessionId ?? s.parent_session ?? s.parent;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** W514：worker 会话只出现在 Worker 组，不再重复列进工作区树。 */
function isWorkerSession(s: SessionInfo): boolean {
  return s.kind === 'worker' || (s.id ?? '').startsWith('worker:');
}

function wsNameOf(s: SessionInfo): string {
  const ws = (s.workspace ?? '').trim();
  return ws === '' ? 'root' : ws;
}

/** 激活高亮只切 class（不重建树，避免闪烁）；真源 = 当前聚焦容器。 */
function updateActiveHighlight(container: HTMLElement): void {
  const act = activeSessionId() || activeSession;
  for (const n of container.querySelectorAll<HTMLElement>('.sess-leaf')) {
    n.classList.toggle('active', n.dataset.id === act);
  }
}

/** 运行态点：只切 class/文案，不重建行（铁律 6：轮询/事件只做局部更新）。 */
function updateBusyDots(container: HTMLElement): void {
  for (const d of container.querySelectorAll<HTMLElement>('.sess-dot[data-dot]')) {
    const id = d.dataset.dot ?? '';
    const busy = paneBusy(id);
    d.classList.toggle('busy', busy);
    d.title = busy ? '运行中' : '空闲';
  }
  for (const row of container.querySelectorAll<HTMLElement>('.ws-worker-row')) {
    const id = row.dataset.id ?? '';
    const busy = paneBusy(id);
    row.classList.toggle('running', busy);
    const st = row.querySelector<HTMLElement>('.ws-worker-state');
    if (st) {
      st.textContent = busy ? '运行中' : '空闲';
      st.classList.toggle('busy', busy);
    }
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

/**
 * 打开会话视图（W514）：
 *   - **立即**切换容器（hidden 切换 / 零重渲染）：别的会话正在跑也照样切，
 *     不等任何网络请求（旧行为：await activate，409 时无法切换）；
 *   - 随后后台 POST /api/sessions/{id}/activate（运行中的目标会话旧后端会 409，
 *     此时视图仍是可看的实时流 —— 只提示，不影响已打开的视图）；
 *   - 高亮/运行态点只切 class（不重建树）。
 */
function openSessionRow(
  container: HTMLElement,
  id: string,
  meta?: { kind?: string; title?: string },
): void {
  openSession(id, meta); // 立即开容器（未恢复过历史 → 离屏双缓冲恢复）
  activeSession = id;
  S.selSession = id;
  updateActiveHighlight(container);
  updateBusyDots(container);
  note('已切换到会话：' + id);
  void api
    .activateSession(id)
    .then((r) => {
      if (r.ok === false) note('视图已打开 · 激活失败：' + (r.error || '—'));
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        note('该会话运行中（视图已打开 · 实时流可见）');
      } else {
        note('视图已打开 · 激活接口不可用：' + (err instanceof Error ? err.message : String(err)));
      }
    });
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

  if (!batchMode) {
    const dot = el('span', 'sess-dot' + (paneBusy(id) ? ' busy' : ''));
    dot.dataset.dot = id;
    dot.title = paneBusy(id) ? '运行中' : '空闲';
    leaf.appendChild(dot);
  }
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
  const kidCount = workersByParent.get(id) ?? 0;
  if (kidCount > 0) {
    const badge = el('span', 'sess-worker-count', 'W' + kidCount);
    badge.title = '该会话下有 ' + kidCount + ' 个 worker 子会话';
    leaf.appendChild(badge);
  }
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
        {
          label: isActive ? '当前会话' : '打开',
          disabled: isActive,
          onPick: () =>
            openSessionRow(container, id, { kind: s.kind === 'worker' ? 'worker' : 'session', title: s.title }),
        },
        { label: '重命名', onPick: () => void renameSession(container, id, s.title || truncateName(id)) },
        { label: '归档', onPick: () => void archiveSession(container, id) },
        { label: '分支', onPick: () => void branchSession(container, id) },
        { label: '删除', danger: true, onPick: () => void deleteSession(container, id) },
      ]);
    });
    leaf.appendChild(kebab);
  }
  leaf.addEventListener('click', () => {
    openSessionRow(container, id, { kind: s.kind === 'worker' ? 'worker' : 'session', title: s.title });
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
      { label: '新建会话', onPick: () => newSession(name) },
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

/** wid：标题前缀「W514·短名」优先，否则取 id 末段。 */
function widOf(w: SessionInfo): string {
  const t = (w.title ?? '').trim();
  const m = /^(W\d+)/.exec(t);
  if (m && m[1]) return m[1];
  const id = w.id ?? '';
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** 标题：去掉「W514·」前缀后的短名（与 wid 标签分列显示）。 */
function workerTitleOf(w: SessionInfo): string {
  const t = (w.title ?? '').trim();
  const stripped = t.replace(/^W\d+\s*[·:：-]\s*/, '');
  return stripped || truncateName(w.id ?? '') || (w.id ?? '');
}

/** Worker 组内容签名：不变则不重建（铁律 6：轮询只做局部更新）。 */
function workerSigOf(workers: SessionInfo[]): string {
  return workers
    .map((w) =>
      [
        w.id ?? '',
        w.title ?? '',
        w.model ?? '',
        paneBusy(w.id ?? '') ? '1' : '0',
        String(w.events ?? ''),
        parentOf(w) ?? '',
      ].join('\u0001'),
    )
    .join('\u0002');
}

/** 渲染一条 Worker 行（child=true 时缩进到父会话之下）。每行：运行态点 · wid · 标题 · 状态 · 模型。 */
function renderWorkerRow(host: HTMLElement, w: SessionInfo, child: boolean): HTMLElement {
  const id = w.id ?? '';
  const busy = paneBusy(id);
  const row = el('div', 'ws-worker-row' + (child ? ' child' : '') + (activeSessionId() === id ? ' active' : ''));
  row.dataset.id = id;
  row.appendChild(el('span', 'sess-dot' + (busy ? ' busy' : '')));
  row.appendChild(el('span', 'ws-worker-wid', widOf(w)));
  row.appendChild(el('span', 'ws-worker-title', workerTitleOf(w)));
  const st = el('span', 'ws-worker-state' + (busy ? ' busy' : ''), busy ? '运行中' : '空闲');
  row.appendChild(st);
  const bits: string[] = [];
  if (w.model) bits.push(String(w.model));
  if (w.events !== undefined) bits.push('ev:' + w.events);
  row.appendChild(el('span', 'ws-worker-meta', bits.join(' · ')));
  row.title = id + (w.model ? ' · ' + w.model : '') + '（点击打开该 worker 会话视图：只读）';
  row.addEventListener('click', () => {
    const hostEl = document.getElementById('sessionTree') ?? host;
    openSessionRow(hostEl, id, { kind: 'worker', title: w.title || id });
  });
  return row;
}

/**
 * 渲染 Worker 组（可展开 details）。
 * W515 谱系：后端给出 parentSessionId（含 parent/parent_session 兼容）时，
 * 按「父会话 → 其 worker 子行（缩进）」展示；父会话行可点击打开该父会话视图。
 * 无任何 parent 字段（旧后端）→ 与现状一致的平坦列表（降级）。
 */
function renderWorkerGroup(host: HTMLElement, workers: SessionInfo[], open: boolean): void {
  const det = document.createElement('details');
  det.className = 'ws-worker-details';
  det.open = open;
  const sum = document.createElement('summary');
  sum.className = 'ws-worker-summary';
  sum.appendChild(el('span', null, '引擎 Worker'));
  sum.appendChild(el('span', 'ws-worker-count', String(workers.length)));
  det.appendChild(sum);

  const byParent = new Map<string, SessionInfo[]>();
  const orphans: SessionInfo[] = [];
  for (const w of workers) {
    const p = parentOf(w);
    if (!p) {
      orphans.push(w);
      continue;
    }
    const list = byParent.get(p);
    if (list) list.push(w);
    else byParent.set(p, [w]);
  }
  // 父会话顺序 = 会话列表顺序（稳定）；未关联的 worker 排在最后
  const ordered = new Set<string>();
  for (const s of sessions) {
    const id = s.id ?? '';
    if (id && byParent.has(id)) ordered.add(id);
  }
  for (const p of byParent.keys()) ordered.add(p);

  if (ordered.size === 0) {
    for (const w of orphans) det.appendChild(renderWorkerRow(host, w, false));
  } else {
    for (const parentId of ordered) {
      const kids = byParent.get(parentId) ?? [];
      const parentSession = sessions.find((s) => s.id === parentId);
      const head = el('div', 'ws-worker-parent');
      head.appendChild(el('span', 'ws-lineage-mark', '└'));
      const pname = el('span', 'ws-worker-parent-name', parentSession?.title || truncateName(parentId));
      head.appendChild(pname);
      head.appendChild(el('span', 'ws-worker-count', String(kids.length)));
      head.title = '父会话：' + parentId + '（点击打开父会话视图）';
      head.addEventListener('click', () => {
        const hostEl = document.getElementById('sessionTree') ?? host;
        openSessionRow(hostEl, parentId, { kind: 'session', title: parentSession?.title });
      });
      det.appendChild(head);
      for (const w of kids) det.appendChild(renderWorkerRow(host, w, true));
    }
    if (orphans.length) {
      const head = el('div', 'ws-worker-parent');
      head.appendChild(el('span', 'ws-lineage-mark', '·'));
      head.appendChild(el('span', 'ws-worker-parent-name', '未关联父会话'));
      det.appendChild(head);
      for (const w of orphans) det.appendChild(renderWorkerRow(host, w, true));
    }
  }
  host.replaceChildren(det);
}

let workerSig = '';

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
  const host = container.querySelector<HTMLElement>('.ws-worker-host');
  if (!host) return;
  const sig = workerSigOf(workers);
  if (sig === workerSig) {
    updateBusyDots(container); // 只切点，不重建组
    return;
  }
  const prevOpen = host.querySelector<HTMLDetailsElement>('.ws-worker-details')?.open ?? true;
  workerSig = sig;
  if (workers.length) renderWorkerGroup(host, workers, prevOpen);
  else host.replaceChildren();
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

/** 新建会话弹窗：标题 + 选择工作区（presetWs 预选）+ 可选模型。
 *  创建成功 → 自动激活（POST /api/sessions/{id}/activate）→ 树刷新 + 活跃高亮
 *  + 聊天区切换到新会话（空历史 + 「以下为本次会话」分隔线）。
 *  任一步失败给出具体提示（W243 端点未就绪时优雅降级）。 */
export function newSession(presetWs?: string): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card');
  card.appendChild(el('div', 'modal-card-title', '新建会话'));
  const titleInput = el('input', 'cfg-input') as HTMLInputElement;
  titleInput.placeholder = '会话标题（必填）';
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
  const wsRow = el('label', 'prov-field');
  wsRow.appendChild(el('span', 'prov-field-label', '工作区'));
  wsRow.appendChild(wsSel);
  card.appendChild(wsRow);

  // 可选模型（W243 任务4 / W262）：跟随默认 + available.models
  // W262：与状态栏模型弹层消费同一份清单（provider store + 静态兜底目录，
  // 后端按 id 去重并给出 provider 显示名），标签沿用「提供商 · id（显示名）」。
  const modelSel = document.createElement('select');
  modelSel.className = 'cfg-input';
  const optDef = document.createElement('option');
  optDef.value = '';
  optDef.textContent = '跟随默认';
  modelSel.appendChild(optDef);
  const modelRow = el('label', 'prov-field');
  modelRow.appendChild(el('span', 'prov-field-label', '模型'));
  modelRow.appendChild(modelSel);
  card.appendChild(modelRow);
  void api
    .config()
    .then((d) => {
      const models = d.available?.models ?? [];
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id;
        const name = m.name || m.id;
        const provider = (m.provider ?? '').trim();
        o.textContent =
          (provider ? provider + ' · ' : '') + m.id + (name !== m.id ? '（' + name + '）' : '');
        modelSel.appendChild(o);
      }
      if (!models.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（暂无可选模型）';
        o.disabled = true;
        modelSel.appendChild(o);
      }
    })
    .catch(() => {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（模型列表暂不可用）';
      o.disabled = true;
      modelSel.appendChild(o);
    });

  // 可选提示词（W245 任务2）：跟随默认 + 注册的 prompts（标注全局/工作区）；404 隐藏
  const promptRow = el('label', 'prov-field');
  promptRow.appendChild(el('span', 'prov-field-label', '提示词'));
  const promptSel = document.createElement('select');
  promptSel.className = 'cfg-input';
  const optPrompt = document.createElement('option');
  optPrompt.value = '';
  optPrompt.textContent = '跟随默认';
  promptSel.appendChild(optPrompt);
  promptRow.appendChild(promptSel);
  promptRow.style.display = 'none';
  card.appendChild(promptRow);
  void api
    .prompts()
    .then((d) => {
      const ps = d.prompts ?? [];
      if (!ps.length) return; // 无注册提示词：保持隐藏
      for (const p of ps) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name + '（' + (p.scope === 'global' ? '全局' : '工作区') + '）' + (p.is_default ? ' · 默认' : '');
        promptSel.appendChild(o);
      }
      promptRow.style.display = ''; // 数据就绪才显示（404 保持隐藏）
    })
    .catch(() => {
      /* 404：提示词注册未开放，保持隐藏 */
    });

  const status = el('div', 'ws-fs-status');
  card.appendChild(status);
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const create = el('button', 'btn btn-accent', '创建') as HTMLButtonElement;
  create.type = 'button';
  // 任务 3：挂到 body 的弹窗打开时 push 自身 close，Esc 只关栈顶一层
  let overlay: OverlayHandle | null = null;
  const close = () => {
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  overlay = pushOverlay(close);
  cancel.addEventListener('click', close);
  create.addEventListener('click', () => {
    const t = titleInput.value.trim();
    if (!t) {
      status.className = 'ws-fs-status err';
      status.textContent = '标题不能为空';
      titleInput.focus();
      return;
    }
    const ws = wsSel.value === '' ? null : wsSel.value;
    const model = modelSel.value === '' ? undefined : modelSel.value;
    const prompt = promptSel.value === '' ? undefined : promptSel.value;
    create.disabled = true;
    create.textContent = '创建中…';
    const doCreate = (withModel: boolean) =>
      api.createSession(
        withModel && model ? { workspace: ws, title: t, model, prompt } : { workspace: ws, title: t, prompt },
      );
    void doCreate(true)
      .catch((err: unknown) => {
        // 降级：后端未支持 model 字段时（4xx）重试不带 model
        const e = err as { status?: number };
        if (model && e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
          return doCreate(false);
        }
        throw err;
      })
      .then(async (r) => {
        if (r.ok === false) {
          throw new Error(r.error || '后端拒绝');
        }
        // 定位新会话 id（响应优先；缺失则按标题取最新）
        let id = r.id;
        if (!id) {
          try {
            const d = await api.sessions();
            const cands = (d.sessions ?? []).filter((x) => x.title === t);
            cands.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
            id = cands[0]?.id;
          } catch {
            id = undefined;
          }
        }
        if (!id) {
          status.className = 'ws-fs-status err';
          status.textContent = '会话已创建，但无法定位其 id——请刷新会话树后手动激活';
          close();
          void loadSessions();
          return;
        }
        // W514：立即打开新会话视图（不等激活结果），激活在后台进行
        openSession(id, { kind: 'session', title: t });
        activeSession = id;
        S.selSession = id;
        note('已创建并打开会话：' + id);
        void api
          .activateSession(id)
          .then((ar) => {
            if (ar.ok === false) note('视图已打开 · 激活失败：' + (ar.error || '—'));
          })
          .catch((err: unknown) => {
            note('视图已打开 · 激活接口不可用：' + (err instanceof Error ? err.message : String(err)));
          });
        close();
        void loadSessions();
      })
      .catch((err: unknown) => {
        status.className = 'ws-fs-status err';
        status.textContent = '创建失败：' + (err instanceof Error ? err.message : String(err));
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
  card.appendChild(el('div', 'modal-card-title', '新建工作区 · 选择目录'));
  card.appendChild(el('div', 'side-note', '选中目录即注册该目录为工作区（名称 = 文件夹名）'));

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

  const status = el('div', 'ws-fs-status');
  card.appendChild(crumbs);
  card.appendChild(tree);
  card.appendChild(addrRow);
  card.appendChild(status);

  function renderCrumbs(path: string): void {
    // 第 26 轮（W256）：根目录快捷 chips 已删除；面包屑始终以可点击的 '/' 开头
    //（路径为空时也渲染 '/' crumb，点击 loadDirs('/')）。
    // 离屏构建 + 单次替换（铁律 1：不先清空可见容器）。
    const off = document.createElement('div');
    const parts = path.split('/').filter(Boolean);
    const rootBtn = el('button', 'ws-fs-crumb' + (parts.length ? '' : ' cur'), '/') as HTMLButtonElement;
    rootBtn.type = 'button';
    rootBtn.title = '根目录 /';
    rootBtn.addEventListener('click', () => void loadDirs('/'));
    off.appendChild(rootBtn);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      acc += '/' + seg;
      const b = el('button', 'ws-fs-crumb' + (i === parts.length - 1 ? ' cur' : ''), seg) as HTMLButtonElement;
      b.type = 'button';
      const target = acc;
      b.addEventListener('click', () => void loadDirs(target));
      off.appendChild(b);
    }
    crumbs.replaceChildren(...off.childNodes);
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
    renderCrumbs(r.path ?? path);
    const off = document.createElement('div');
    const dirs = r.dirs ?? [];
    if (!dirs.length) off.appendChild(el('div', 'side-note', '（该目录下没有子目录）'));
    for (const d of dirs) {
      const row = el('div', 'ws-fs-dir');
      const icon = el('span', 'ws-fs-dir-icon');
      icon.appendChild(svgIcon('folder')); // 第 26 轮：'▸' 文本图标 → 文件夹 SVG
      row.appendChild(icon);
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
  // 任务 3：挂到 body 的弹窗打开时 push 自身 close，Esc 只关栈顶一层
  let overlay: OverlayHandle | null = null;
  const close = () => {
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  overlay = pushOverlay(close);
  cancel.addEventListener('click', close);
  create.addEventListener('click', () => {
    const path = curPath || addrInput.value.trim();
    if (!path) {
      status.className = 'ws-fs-status err';
      status.textContent = '请先选择/输入目录路径';
      addrInput.focus();
      return;
    }
    create.disabled = true;
    create.textContent = '注册中…';
    void api
      .createWorkspaceByPath(path)
      .then((r) => {
        if (r.ok === false) {
          status.className = 'ws-fs-status err';
          status.textContent = '注册失败：' + (r.error || '—');
          create.disabled = false;
          create.textContent = '注册';
          return;
        }
        note('工作区已注册：' + path);
        close();
        void loadSessions();
      })
      .catch((err: unknown) => {
        status.className = 'ws-fs-status err';
        status.textContent = '注册失败：' + (err instanceof Error ? err.message : String(err));
        create.disabled = false;
        create.textContent = '注册';
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
    // W514：容器元数据（kind/标题/模型）+ 远端运行态（busy 字段缺失 → 不覆盖本地）
    for (const s of sessions) {
      const id = s.id ?? '';
      if (!id) continue;
      setPaneMeta(id, {
        kind: s.kind === 'worker' ? 'worker' : s.kind === 'session' ? 'session' : undefined,
        title: s.title,
        model: s.model,
        workspace: s.workspace ?? undefined,
      });
      if (typeof s.busy === 'boolean') setRemoteBusy(id, s.busy);
    }
    const act = (d.sessions ?? []).find((s) => s.active === true);
    // 客户端已打开的容器是更强真源：不因后端 active 字段把高亮带偏
    const open = activeSessionId();
    if (open) activeSession = open;
    else if (act?.id) activeSession = act.id;
  } catch (err) {
    stopWorkerPoll();
    off.appendChild(el('div', 'side-note err', '会话接口不可用'));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    container.replaceChildren(...off.childNodes);
    if (countEl) countEl.textContent = '—';
    return;
  }

  const treeSessions = sessions.filter((s) => !isWorkerSession(s));
  const wsNames = new Set<string>();
  for (const s of treeSessions) if (!s.archived) wsNames.add(wsNameOf(s));
  for (const n of wsNames) {
    if (!wsList.some((w) => w.name === n)) wsList.push({ name: n });
  }
  wsList.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (countEl) countEl.textContent = String(treeSessions.filter((s) => s.archived !== true).length);

  // W515：父会话 → worker 子会话数（建树前算好，供父会话行徽标使用）
  const workers = workerSessions(sessions);
  workersByParent = new Map();
  for (const w of workers) {
    const p = parentOf(w);
    if (!p) continue;
    workersByParent.set(p, (workersByParent.get(p) ?? 0) + 1);
  }

  renderToolbar(off);

  // 树：按工作区收束（可折叠）
  const tree = el('div', 'ws-tree');
  const wsWith = wsList.filter(
    (w) =>
      matchesQuery(w.name) ||
      treeSessions.some((s) => !s.archived && wsNameOf(s) === w.name && matchesQuery(s.title ?? s.id ?? '')),
  );
  let rendered = 0;
  for (const w of wsWith) {
    const list = treeSessions.filter(
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

  // 引擎 Worker 组（W514：常驻 host —— 轮询只替换 host 内容，不重建整棵树）
  const wHost = el('div', 'ws-worker-host');
  off.appendChild(wHost);
  workerSig = workerSigOf(workers);
  if (workers.length) {
    renderWorkerGroup(wHost, workers, true);
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
  // W514：元数据（标题/kind）回填后同步会话条与运行态点（只改文本/class）
  updateBusyDots(container);
  updateSessionBar();
}

// ---- 装配 ------------------------------------------------------------------------

export function loadSessions(): Promise<void> {
  return loadTreeInto(need<HTMLElement>('#sessionTree'), need<HTMLElement>('#sessionCount'));
}


export function initSessionsPanel(): void {
  // 第 22 轮：清空/刷新入口已移除（后端端点保留）
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.sess-menu')) closeCtxMenu();
  });
  // W514：任一会话运行态变化 → 只更新侧栏运行态点/Worker 行状态（局部）
  onBusyChange(() => {
    const c = document.getElementById('sessionTree');
    if (!c) return;
    updateBusyDots(c);
    const host = c.querySelector<HTMLElement>('.ws-worker-host');
    if (host) void refreshWorkers(c); // 只重建 Worker 组（签名变化时）
  });
  void loadSessions();
}
