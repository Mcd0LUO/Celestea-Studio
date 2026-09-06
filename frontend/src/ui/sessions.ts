// ============================================================================
// ui/sessions.ts — 左侧「工作区/会话树」面板（W227 替代原平铺会话列表）：
//   GET /api/sessions 按 workspace 分组：host（workspace=null）→「主会话」组，
//   persistent → 按 workspace 字段分组；可折叠树：工作区节点 → 会话叶子。
//   点击叶子仅做选中态高亮（tooltip 展示 kind/事件数/file 等元信息，不切换
//   聊天区视图、不发起任何请求）；「清空」保留原 /api/clear 行为。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { SessionInfo } from '../types';
import { S } from '../state';
import { resetMessages } from './messages';

const treeEl = need<HTMLElement>('#sessionTree');
const countEl = need<HTMLElement>('#sessionCount');

const MAIN_GROUP = '主会话';
const UNGROUPED = '未分组';

interface Group {
  name: string;
  sessions: SessionInfo[];
}

function groupSessions(list: SessionInfo[]): Group[] {
  const map = new Map<string, SessionInfo[]>();
  const push = (name: string, s: SessionInfo) => {
    let arr = map.get(name);
    if (!arr) {
      arr = [];
      map.set(name, arr);
    }
    arr.push(s);
  };
  for (const s of list) {
    if (s.kind === 'host' || s.live === true) {
      push(MAIN_GROUP, s);
    } else {
      const ws = (s.workspace ?? '').trim();
      push(ws === '' ? UNGROUPED : ws, s);
    }
  }
  const groups = Array.from(map.entries()).map(([name, sessions]) => ({ name, sessions }));
  groups.sort((a, b) => {
    if (a.name === MAIN_GROUP) return -1;
    if (b.name === MAIN_GROUP) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return groups;
}

function renderLeaf(s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const leaf = el('div', 'tree-leaf' + (S.selSession === id ? ' active' : ''));
  leaf.dataset.id = id;
  const title = el('div', 'tree-leaf-title');
  const dot = el('span', 'tree-dot' + (s.kind === 'host' || s.live === true ? ' live' : ''));
  title.appendChild(dot);
  title.appendChild(el('span', 'tree-leaf-name', s.title || '(未命名)'));
  leaf.appendChild(title);
  const meta = el('div', 'tree-leaf-meta');
  const bits: string[] = [];
  if (s.kind) bits.push(s.kind);
  if (s.events !== undefined) bits.push('ev:' + s.events);
  bits.push(id);
  meta.textContent = bits.join(' · ');
  // tooltip：kind / 事件数 / id / workspace / file 路径（仅元信息，不切换视图）
  leaf.title = meta.textContent
    + (s.workspace ? ' · ' + s.workspace : '')
    + (s.file ? ' · ' + s.file : '');
  leaf.appendChild(meta);
  leaf.addEventListener('click', () => {
    // 仅选中态高亮：不发起请求、不切换聊天区内容
    S.selSession = id;
    for (const n of treeEl.querySelectorAll<HTMLElement>('.tree-leaf')) {
      n.classList.toggle('active', n.dataset.id === id);
    }
  });
  return leaf;
}

function renderTree(sessions: SessionInfo[] | undefined): void {
  const arr = sessions ?? [];
  countEl.textContent = String(arr.length);
  treeEl.innerHTML = '';
  if (!arr.length) {
    treeEl.appendChild(el('div', 'side-note', '无会话记录'));
    return;
  }
  const groups = groupSessions(arr);
  for (const g of groups) {
    const det = document.createElement('details');
    det.className = 'tree-group';
    det.open = g.name === MAIN_GROUP || groups.length === 1;
    const sum = document.createElement('summary');
    sum.className = 'tree-group-head';
    sum.appendChild(el('span', 'tree-caret'));
    sum.appendChild(el('span', 'tree-group-name', g.name));
    sum.appendChild(el('span', 'tree-group-count', String(g.sessions.length)));
    det.appendChild(sum);
    for (const s of g.sessions) det.appendChild(renderLeaf(s));
    treeEl.appendChild(det);
  }
}

export function loadSessions(): Promise<void> {
  treeEl.innerHTML = '<div class="side-note">加载中…</div>';
  return api
    .sessions()
    .then((d) => {
      S.sessions = d.sessions ?? [];
      renderTree(S.sessions);
    })
    .catch((err: unknown) => {
      treeEl.innerHTML = '';
      treeEl.appendChild(el('div', 'side-note err', '会话接口不可用'));
      treeEl.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    });
}

export function initSessionsPanel(): void {
  need<HTMLButtonElement>('#btnReloadSessions').addEventListener('click', () => {
    void loadSessions();
  });
  need<HTMLButtonElement>('#btnClearSess').addEventListener('click', () => {
    if (!window.confirm('确认清空当前会话？')) return;
    void api
      .clear()
      .then((d) => {
        const foot = document.getElementById('sideFoot');
        if (d.ok) {
          if (foot) foot.textContent = '会话已清空';
          resetMessages();
          S.assistant = null;
          S.turn = null;
        } else if (foot) {
          foot.textContent = '清空失败（返回异常）';
        }
      })
      .catch((err: unknown) => {
        const foot = document.getElementById('sideFoot');
        if (foot) foot.textContent = '清空失败：' + (err instanceof Error ? err.message : String(err));
      });
  });
  void loadSessions();
}
