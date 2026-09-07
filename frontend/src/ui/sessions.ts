// ============================================================================
// ui/sessions.ts — 左侧「工作区/会话树」（W236 契约）：
//   树：工作区节点 → 会话叶子（host cli-main 置顶；已归档不显示）；
//   每工作区「⋯」→ 二级菜单（删除工作区 / 批量操作会话）；
//   每会话「⋯」→ 二级菜单（归档 / 删除）；
//   批量模式（复选 + 批量归档/删除操作条）；
//   「新建工作区」「新建会话」入口（会话弹窗：标题 + 选择工作区）。
//   端点缺失（后端 W236 并行开发中）→ 优雅降级不崩溃。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { SessionInfo, WorkspaceInfo } from '../types';
import { S } from '../state';
import { resetMessages } from './messages';

const MAIN_GROUP = '主会话';
const UNGROUPED = '未分组';

// ---- 批量模式状态 --------------------------------------------------------------

let batchMode = false;
const selected = new Set<string>();

function exitBatch(container: HTMLElement): void {
  batchMode = false;
  selected.clear();
  void loadTreeInto(container, null); // 重渲染：取消复选与批量条
}

/** 渲染容器内所有 checkbox 的选中态（批量模式；组头为部分/全选态）。 */
function refreshChecks(container: HTMLElement): void {
  for (const cb of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    const ws = cb.dataset.ws;
    if (ws !== undefined) {
      const node = cb.closest('.ws-node');
      const leaves = node ? Array.from(node.querySelectorAll<HTMLElement>('.sess-leaf')) : [];
      const ids = leaves.map((l) => l.dataset.id ?? '').filter(Boolean);
      const hit = ids.filter((i) => selected.has(i)).length;
      cb.checked = ids.length > 0 && hit === ids.length;
      cb.indeterminate = hit > 0 && hit < ids.length;
      continue;
    }
    cb.checked = cb.dataset.id !== undefined && selected.has(cb.dataset.id);
  }
  setBatchBar(container);
}

function setBatchBar(container: HTMLElement | null): void {
  const bar = container?.querySelector<HTMLElement>('.sess-batchbar');
  if (!bar) return;
  const n = selected.size;
  bar.querySelector('.sess-batchbar-count')!.textContent = '已选 ' + n;
  bar.classList.toggle('active', batchMode && n > 0);
}

// ---- 树构建 ---------------------------------------------------------------------

interface WsNode {
  name: string;
  path?: string;
  sessions: SessionInfo[];
}

function collectNodes(sessions: SessionInfo[], wsList: WorkspaceInfo[] | null): WsNode[] {
  const map = new Map<string, WsNode>();
  const get = (name: string): WsNode => {
    let n = map.get(name);
    if (!n) {
      n = { name, sessions: [] };
      map.set(name, n);
    }
    return n;
  };
  for (const s of sessions) {
    if (s.kind === 'host' || s.live === true) continue; // 主会话单独置顶
    if (s.archived === true) continue; // 已归档不显示在主树
    const ws = (s.workspace ?? '').trim() || 'root';
    get(ws).sessions.push(s);
  }
  if (wsList) {
    for (const w of wsList) get(w.name).path = w.path;
  }
  const nodes = Array.from(map.values());
  nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const n of nodes) {
    n.sessions.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
  }
  return nodes;
}

function truncateName(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

// ---- 右键菜单（浮层） -----------------------------------------------------------

interface MenuItem {
  label: string;
  danger?: boolean;
  onPick: () => void;
}

function openCtxMenu(container: HTMLElement, x: number, y: number, items: MenuItem[]): void {
  closeCtxMenu();
  const m = el('div', 'sess-menu');
  for (const it of items) {
    const b = el('button', 'sess-menu-item' + (it.danger ? ' danger' : ''), it.label) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCtxMenu();
      it.onPick();
    });
    m.appendChild(b);
  }
  container.appendChild(m);
  const xc = Math.max(0, Math.min(x, container.clientWidth - 170));
  const yc = Math.max(0, Math.min(y, container.clientHeight - 40));
  m.style.left = xc + 'px';
  m.style.top = yc + 'px';
}

function closeCtxMenu(): void {
  for (const n of document.querySelectorAll('.sess-menu')) n.remove();
}

// ---- 操作 ------------------------------------------------------------------------

function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

function wsNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.ws-node .ws-name')).map((n) => n.textContent ?? '');
}

async function deleteWorkspace(container: HTMLElement, name: string): Promise<void> {
  if (!window.confirm('确认删除工作区「' + name + '」？（含其下会话）')) return;
  try {
    await api.deleteWorkspace(name);
    note('工作区已删除');
    void loadTreeInto(container, null);
  } catch (err) {
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function archiveSession(container: HTMLElement, id: string): Promise<void> {
  try {
    await api.archiveSession(id);
    void loadTreeInto(container, null);
  } catch (err) {
    note('归档失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function deleteSession(container: HTMLElement, id: string): Promise<void> {
  if (!window.confirm('确认删除会话「' + id + '」？')) return;
  try {
    await api.batchDeleteSessions([id]);
    void loadTreeInto(container, null);
  } catch (err) {
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function batchAction(container: HTMLElement, action: 'archive' | 'delete'): Promise<void> {
  const ids = Array.from(selected);
  if (!ids.length) return;
  const label = action === 'archive' ? '归档' : '删除';
  if (action === 'delete' && !window.confirm('确认批量删除 ' + ids.length + ' 个会话？')) return;
  try {
    if (action === 'archive') await api.batchArchiveSessions(ids);
    else await api.batchDeleteSessions(ids);
    exitBatch(container);
  } catch (err) {
    note('批量' + label + '失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---- 渲染 ------------------------------------------------------------------------

function renderLeaf(container: HTMLElement, s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const leaf = el('div', 'sess-leaf' + (S.selSession === id ? ' active' : ''));
  leaf.dataset.id = id;

  if (batchMode) {
    const cb = el('input', 'sess-check') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.dataset.id = id;
    cb.checked = selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      setBatchBar(container);
    });
    leaf.appendChild(cb);
  }
  leaf.appendChild(el('span', 'sess-dot' + (s.kind === 'host' || s.live === true ? ' live' : '')));
  const name = el('span', 'sess-leaf-name', s.title || truncateName(id) || '(未命名)');
  leaf.appendChild(name);
  const metaBits: string[] = [];
  if (s.events !== undefined) metaBits.push('ev:' + s.events);
  metaBits.push(truncateName(id));
  leaf.appendChild(el('span', 'sess-leaf-meta', metaBits.join(' · ')));
  leaf.title = id + (s.workspace ? ' · ' + s.workspace : '') + (s.file ? ' · ' + s.file : '');

  // 点击 = 选中态高亮（不改聊天区）
  leaf.addEventListener('click', () => {
    S.selSession = id;
    for (const n of container.querySelectorAll<HTMLElement>('.sess-leaf')) {
      n.classList.toggle('active', n.dataset.id === id);
    }
  });

  // 「⋯」菜单（批量模式下隐藏；host 无操作）
  if (!batchMode && s.kind !== 'host' && !s.live) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = '会话操作';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = kebab.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      openCtxMenu(container, r.left - cr.left, r.bottom - cr.top + 4, [
        { label: '归档', onPick: () => void archiveSession(container, id) },
        { label: '删除', danger: true, onPick: () => void deleteSession(container, id) },
      ]);
    });
    leaf.appendChild(kebab);
  }
  return leaf;
}

function renderWorkspaceNode(container: HTMLElement, n: WsNode): HTMLElement {
  const wrap = el('div', 'ws-node');
  const det = document.createElement('details');
  det.className = 'ws-details';
  det.open = true;
  const sum = document.createElement('summary');
  sum.className = 'ws-head';
  if (batchMode) {
    const cb = el('input', 'sess-check') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.dataset.ws = n.name;
    cb.checked = n.sessions.length > 0 && n.sessions.every((x) => selected.has(x.id ?? ''));
    cb.addEventListener('change', () => {
      for (const x of n.sessions) {
        const sid = x.id ?? '';
        if (cb.checked) selected.add(sid);
        else selected.delete(sid);
      }
      refreshChecks(container);
    });
    sum.appendChild(cb);
  }
  sum.appendChild(el('span', 'ws-caret'));
  sum.appendChild(el('span', 'ws-name', n.name === '' ? UNGROUPED : n.name));
  sum.appendChild(el('span', 'ws-path', n.path ?? ''));
  sum.appendChild(el('span', 'ws-count', String(n.sessions.length)));
  if (!batchMode) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = '工作区操作';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = kebab.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      openCtxMenu(container, r.left - cr.left, r.bottom - cr.top + 4, [
        { label: '批量操作会话', onPick: () => { batchMode = true; selected.clear(); void loadTreeInto(container, null); } },
        { label: '删除工作区', danger: true, onPick: () => void deleteWorkspace(container, n.name) },
      ]);
    });
    sum.appendChild(kebab);
  }
  det.appendChild(sum);
  const body = el('div', 'ws-body');
  for (const s of n.sessions) body.appendChild(renderLeaf(container, s));
  det.appendChild(body);
  wrap.appendChild(det);
  return wrap;
}

function renderHostSection(container: HTMLElement, hostSessions: SessionInfo[]): HTMLElement | null {
  if (!hostSessions.length) return null;
  const sec = el('div', 'ws-host');
  const head = el('div', 'ws-host-head', MAIN_GROUP);
  sec.appendChild(head);
  for (const s of hostSessions) sec.appendChild(renderLeaf(container, s));
  return sec;
}

// ---- 新建入口 ---------------------------------------------------------------------

export function newWorkspace(): void {
  const name = window.prompt('新建工作区 · 名称（字母/数字/下划线/斜杠）', '');
  if (name === null) return;
  const t = name.trim();
  if (t === '') return;
  void api
    .createWorkspace(t)
    .then(() => {
      const foot = document.getElementById('sideFoot');
      if (foot) foot.textContent = '工作区已创建：' + t;
      void loadSessions();
    })
    .catch((err: unknown) => {
      const foot = document.getElementById('sideFoot');
      if (foot) foot.textContent = '创建工作区失败：' + (err instanceof Error ? err.message : String(err));
    });
}

/** 新建会话弹窗：标题 + 选择工作区。 */
export function newSession(container: HTMLElement): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card');
  card.appendChild(el('div', 'modal-card-title', '新建会话'));
  const titleInput = el('input', 'cfg-input') as HTMLInputElement;
  titleInput.placeholder = '会话标题';
  card.appendChild(titleInput);
  const wsNamesList = wsNames(container);
  const wsSel = document.createElement('select');
  wsSel.className = 'cfg-input';
  const optRoot = document.createElement('option');
  optRoot.value = '';
  optRoot.textContent = '默认工作区（root）';
  wsSel.appendChild(optRoot);
  for (const w of wsNamesList) {
    if (w === MAIN_GROUP) continue;
    const o = document.createElement('option');
    o.value = w;
    o.textContent = w;
    wsSel.appendChild(o);
  }
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
        const foot = document.getElementById('sideFoot');
        if (foot) foot.textContent = '会话已创建：' + t;
        close();
        void loadSessions();
      })
      .catch((err: unknown) => {
        const foot = document.getElementById('sideFoot');
        if (foot) foot.textContent = '创建会话失败：' + (err instanceof Error ? err.message : String(err));
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

// ---- 树渲染主流程 ----------------------------------------------------------------

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

/** 载入并渲染工作区/会话树（侧栏与设置页「会话」页复用）。 */
export async function loadTreeInto(container: HTMLElement, countEl: HTMLElement | null): Promise<void> {
  closeCtxMenu();
  container.innerHTML = '';
  if (countEl) countEl.textContent = '…';

  let wsList: WorkspaceInfo[] | null = null;
  try {
    const w = await api.workspaces();
    wsList = w.workspaces ?? null;
  } catch {
    wsList = null; // 降级：仅按 sessions 分组
  }

  let sessions: SessionInfo[];
  try {
    const d = await api.sessions();
    sessions = d.sessions ?? [];
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', 'side-note err', '会话接口不可用'));
    container.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    if (countEl) countEl.textContent = '—';
    return;
  }

  if (countEl) countEl.textContent = String(sessions.filter((s) => s.archived !== true).length);
  if (batchMode) renderBatchBar(container);

  const hostSessions = sessions.filter((s) => s.kind === 'host' || s.live === true);
  const host = renderHostSection(container, hostSessions);
  if (host) container.appendChild(host);

  const nodes = collectNodes(sessions, wsList);
  if (!nodes.length && !host) {
    container.appendChild(el('div', 'side-note', '无会话记录'));
    return;
  }
  for (const n of nodes) container.appendChild(renderWorkspaceNode(container, n));
}

// ---- 装配 ------------------------------------------------------------------------

export function loadSessions(): Promise<void> {
  return loadTreeInto(need<HTMLElement>('#sessionTree'), need<HTMLElement>('#sessionCount'));
}

export function initSessionsPanel(): void {
  const tree = need<HTMLElement>('#sessionTree');
  need<HTMLButtonElement>('#btnReloadSessions').addEventListener('click', () => {
    void loadSessions();
  });
  need<HTMLButtonElement>('#btnClearSess').addEventListener('click', () => {
    clearCurrentSession();
  });
  need<HTMLButtonElement>('#btnNewWs').addEventListener('click', newWorkspace);
  need<HTMLButtonElement>('#btnNewSess').addEventListener('click', () => newSession(tree));
  document.addEventListener('click', (e) => {
    // 点击外部关闭菜单（菜单内按钮已 stopPropagation）
    if (!(e.target instanceof Element) || !e.target.closest('.sess-menu')) closeCtxMenu();
  });
  void loadSessions();
}

/** 清空当前会话（确认后 /api/clear + 本地消息流复位）。 */
export function clearCurrentSession(foot?: HTMLElement | null): void {
  if (!window.confirm('确认清空当前会话？')) return;
  void api
    .clear()
    .then((d) => {
      const f = foot ?? document.getElementById('sideFoot');
      if (d.ok) {
        if (f) f.textContent = '会话已清空';
        resetMessages();
        S.assistant = null;
        S.turn = null;
      } else if (f) {
        f.textContent = '清空失败（返回异常）';
      }
    })
    .catch((err: unknown) => {
      const f = foot ?? document.getElementById('sideFoot');
      if (f) f.textContent = '清空失败：' + (err instanceof Error ? err.message : String(err));
    });
}
