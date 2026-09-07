// ============================================================================
// ui/sessions.ts — 左侧「会话列表」：Codex 风格横向长条（W227 续 W230 决策：
//   点击长条仅选中态高亮，不切换聊天区；cli-main 置顶）。
//   - 数据：GET /api/sessions，按 workspace 分组为小节标题（host→「主会话」）；
//   - #1 鼠标靠近长条 → 平滑变长（--grow 权重 + transition，吸附效果）；
//   - #2 hover 停留（防抖 350ms）→ 展开预览：第一条 user 首行前 ~40 字
//         + 分割线 + 其后第一条 assistant 前 ~40 字（懒加载 messages，
//         每会话缓存；404 优雅降级）；
//   - #3 邻近度：按鼠标到各长条中心的距离加权，邻近者最长，向两侧递减。
//   侧栏与「通用设置 → 会话」页共用本模块（缓存共享）。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { SessionInfo } from '../types';
import { S } from '../state';
import { resetMessages } from './messages';

const PREVIEW_DEBOUNCE_MS = 350; // hover 停留防抖
const PREVIEW_CHARS = 40;        // Q/A 各截断字数
const PROXIMITY_RANGE = 260;     // 邻近度衰减半径（px）

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
    if (s.kind === 'host' || s.live === true) push(MAIN_GROUP, s);
    else {
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
  for (const g of groups) {
    // 组内：cli-main 置顶，其余按标题
    g.sessions.sort((a, b) => {
      const ai = a.id === 'cli-main' ? -1 : a.id === undefined ? 0 : 1;
      const bi = b.id === 'cli-main' ? -1 : b.id === undefined ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.title || '').localeCompare(b.title || '', 'zh');
    });
  }
  return groups;
}

// ---- 预览（懒加载 + 缓存） ---------------------------------------------------

interface Preview {
  ok: boolean;
  q?: string;
  a?: string;
  error?: string;
}

const previewCache = new Map<string, Promise<Preview>>();

function truncate(s: string): string {
  const line = s.replace(/\s+/g, ' ').trim();
  if (line.length <= PREVIEW_CHARS) return line;
  return line.slice(0, PREVIEW_CHARS) + '…';
}

function loadPreview(id: string): Promise<Preview> {
  let p = previewCache.get(id);
  if (p) return p;
  p = api
    .messages(id)
    .then((d) => {
      const msgs = d.messages ?? [];
      let q: string | undefined;
      let a: string | undefined;
      for (const m of msgs) {
        if (q === undefined && m.role === 'user') {
          q = truncate(String(m.content));
          continue;
        }
        if (q !== undefined && m.role === 'assistant') {
          a = truncate(String(m.content));
          break;
        }
      }
      return { ok: true, q, a };
    })
    .catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  previewCache.set(id, p);
  return p;
}

// ---- 渲染 ---------------------------------------------------------------------

function renderBar(s: SessionInfo, container: HTMLElement): HTMLElement {
  const id = s.id ?? '';
  const bar = el('div', 'sess-bar' + (S.selSession === id ? ' active' : ''));
  bar.dataset.id = id;

  const row = el('div', 'sess-bar-row');
  row.appendChild(el('span', 'sess-bar-dot' + (s.kind === 'host' || s.live === true ? ' live' : '')));
  row.appendChild(el('span', 'sess-bar-name', s.title || '(未命名)'));
  const bits: string[] = [];
  if (s.kind) bits.push(s.kind);
  if (s.events !== undefined) bits.push('ev:' + s.events);
  bits.push(id);
  row.appendChild(el('span', 'sess-bar-meta', bits.join(' · ')));
  bar.appendChild(row);

  const pv = el('div', 'sess-bar-preview');
  bar.appendChild(pv);

  bar.title = bits.join(' · ') + (s.workspace ? ' · ' + s.workspace : '') + (s.file ? ' · ' + s.file : '');

  // 点击 = 选中态高亮（延续 W230 决策：不切换聊天区、不发起请求）
  bar.addEventListener('click', () => {
    S.selSession = id;
    if (!container) return;
    for (const n of container.querySelectorAll<HTMLElement>('.sess-bar')) {
      n.classList.toggle('active', n.dataset.id === id);
    }
  });
  return bar;
}

function renderGroups(container: HTMLElement, sessions: SessionInfo[]): void {
  container.innerHTML = '';
  if (!sessions.length) {
    container.appendChild(el('div', 'side-note', '无会话记录'));
    return;
  }
  for (const g of groupSessions(sessions)) {
    const group = el('div', 'sess-group');
    const title = el('div', 'sess-group-title');
    title.appendChild(el('span', 'sess-group-name', g.name));
    title.appendChild(el('span', 'sess-group-count', String(g.sessions.length)));
    group.appendChild(title);
    for (const s of g.sessions) group.appendChild(renderBar(s, container));
    container.appendChild(group);
  }
}

async function expandPreview(bar: HTMLElement): Promise<void> {
  const id = bar.dataset.id ?? '';
  const pv = bar.querySelector<HTMLElement>('.sess-bar-preview');
  if (!pv) return;
  pv.innerHTML = '';
  pv.appendChild(el('div', 'sess-bar-pv-note', '加载预览…'));
  pv.classList.add('open');
  const p = await loadPreview(id);
  if (!bar.isConnected) return; // 预览加载期间列表已重渲染
  pv.innerHTML = '';
  if (!p.ok) {
    pv.appendChild(el('div', 'sess-bar-pv-note err', '预览不可用：' + (p.error || '—')));
    return;
  }
  if (p.q === undefined && p.a === undefined) {
    pv.appendChild(el('div', 'sess-bar-pv-note', '暂无消息'));
    return;
  }
  if (p.q !== undefined) {
    const ql = el('div', 'sess-bar-pv-line sess-bar-pv-q');
    ql.appendChild(el('span', 'sess-bar-pv-tag', 'Q'));
    ql.appendChild(el('span', null, p.q));
    pv.appendChild(ql);
  }
  if (p.q !== undefined && p.a !== undefined) pv.appendChild(el('div', 'sess-bar-pv-sep'));
  if (p.a !== undefined) {
    const al = el('div', 'sess-bar-pv-line sess-bar-pv-a');
    al.appendChild(el('span', 'sess-bar-pv-tag', 'A'));
    al.appendChild(el('span', null, p.a));
    pv.appendChild(al);
  }
}

// ---- 交互（悬停变长 / 停留预览 / 邻近度） --------------------------------------

function attachSessionBars(container: HTMLElement): void {
  if (container.dataset.sessBound === '1') return;
  container.dataset.sessBound = '1';

  let hoverTimer: number | null = null;
  let rafPending = false;

  const setGrow = (b: HTMLElement, g: number) => b.style.setProperty('--grow', g.toFixed(3));

  container.addEventListener('mouseover', (e) => {
    const target = e.target instanceof Element ? (e.target as Element).closest('.sess-bar') : null;
    if (!target || !container.contains(target)) return;
    const bar = target as HTMLElement;
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    // 关闭其它长条的展开预览
    for (const other of container.querySelectorAll<HTMLElement>('.sess-bar-preview.open')) {
      if (other.parentElement !== bar) other.classList.remove('open');
    }
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null;
      void expandPreview(bar);
    }, PREVIEW_DEBOUNCE_MS);
  });

  container.addEventListener('mouseleave', () => {
    if (hoverTimer !== null) {
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    for (const pv of container.querySelectorAll<HTMLElement>('.sess-bar-preview.open')) {
      pv.classList.remove('open');
    }
    for (const b of container.querySelectorAll<HTMLElement>('.sess-bar')) setGrow(b, 0);
  });

  // 邻近度：鼠标越近的长条越长，向两侧递减（rAF 节流）
  container.addEventListener('mousemove', (e) => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const rect = container.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom) return;
      const bars = Array.from(container.querySelectorAll<HTMLElement>('.sess-bar'));
      if (!bars.length) return;
      for (const b of bars) {
        const r = b.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const dist = Math.abs(e.clientY - center);
        setGrow(b, Math.max(0, 1 - dist / PROXIMITY_RANGE));
      }
    });
  });
}

// ---- 公共 API -----------------------------------------------------------------

/** 载入会话长条列表（供侧栏与「通用设置 → 会话」页复用；点击仅选中）。 */
export function loadSessionBars(container: HTMLElement, countEl: HTMLElement | null): Promise<void> {
  attachSessionBars(container);
  if (countEl) countEl.textContent = '…';
  return api
    .sessions()
    .then((d) => {
      S.sessions = d.sessions ?? [];
      if (countEl) countEl.textContent = String(S.sessions.length);
      renderGroups(container, S.sessions);
    })
    .catch((err: unknown) => {
      container.innerHTML = '';
      container.appendChild(el('div', 'side-note err', '会话接口不可用'));
      container.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
      if (countEl) countEl.textContent = '—';
    });
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

// ---- 侧栏装配 -----------------------------------------------------------------

export function loadSessions(): Promise<void> {
  return loadSessionBars(need<HTMLElement>('#sessionTree'), need<HTMLElement>('#sessionCount'));
}

export function initSessionsPanel(): void {
  need<HTMLButtonElement>('#btnReloadSessions').addEventListener('click', () => {
    void loadSessions();
  });
  need<HTMLButtonElement>('#btnClearSess').addEventListener('click', () => {
    clearCurrentSession();
  });
  void loadSessions();
}
