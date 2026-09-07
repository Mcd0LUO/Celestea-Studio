// ============================================================================
// ui/rail.ts — 聊天页左侧「消息 rail」（W236 灵动修正）：
//   会话内每条已发送消息 / 每条回复对应一根横向长条，按消息顺序纵向排列
//   在主聊天区左侧；鼠标靠近时长条变长吸附（transition），邻近者最长、
//   向两侧按距离递减（邻近度权重）；hover 停留 ~350ms 弹出预览：
//   首行前若干字 + 分割线 +（若为提问）对应回复前若干字；
//   点击长条平滑滚动定位到对应消息。未悬停/窄屏时保持细条不干扰阅读。
//   数据完全来自聊天区 DOM（不额外请求）。
// ============================================================================
import { el } from '../utils/dom';

const PREVIEW_MS = 350; // hover 停留防抖
const PREVIEW_CHARS = 40;
const RAIL_HIT = 110;   // 邻近度生效的横向距离（px，自消息区左缘）
const GROW_RANGE = 190; // 纵向衰减半径（px）
const ITEM_H = 20;

interface RailItem {
  col: HTMLElement;
  role: 'user' | 'assistant';
  el: HTMLElement;
  label: HTMLElement;
  top: number;
}

let msgsEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let items: RailItem[] = [];
let hoverTimer: number | null = null;
let hoverItem: RailItem | null = null;
let rafPending = false;

function ensureTrack(): boolean {
  if (!msgsEl) return false;
  if (!track || !track.isConnected) {
    track = document.createElement('div');
    track.className = 'msgrail';
    msgsEl.appendChild(track);
  }
  return true;
}

/** 创建消息时注册（addUserMessage / ensureAssistant 调用）。 */
export function railAdd(col: HTMLElement, role: 'user' | 'assistant'): void {
  if (!ensureTrack() || !track) return;
  const itemEl = document.createElement('div');
  itemEl.className = 'msgrail-item' + (role === 'assistant' ? ' is-reply' : '');
  const dot = document.createElement('span');
  dot.className = 'msgrail-dot';
  const label = document.createElement('span');
  label.className = 'msgrail-label';
  itemEl.appendChild(dot);
  itemEl.appendChild(label);
  track.appendChild(itemEl);
  const item: RailItem = { col, role, el: itemEl, label, top: col.offsetTop };
  items.push(item);
  itemEl.style.top = item.top + 'px';
  itemEl.addEventListener('click', () => {
    col.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  syncTop(item);
}

/** 清空会话时调用（重建轨道，因为消息容器被 innerHTML 清空）。 */
export function railReset(): void {
  items = [];
  hoverItem = null;
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (track) {
    track.remove();
    track = null;
  }
}

/** 聊天区重渲染后同步条目位置与标签（流式气泡高度变化时由 messages.ts 调用）。 */
export function railSync(): void {
  if (!msgsEl) return;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const it of items) {
      syncTop(it);
      if (it.label.dataset.done !== '1') {
        const t = labelText(it.col);
        if (t) {
          it.label.textContent = t;
          it.label.dataset.done = '1';
        }
      }
    }
    if (hoverItem) positionCard(hoverItem);
  });
}

function syncTop(it: RailItem): void {
  const t = it.col.offsetTop + Math.max(0, (it.col.offsetHeight - ITEM_H) / 2 - 4);
  it.top = t;
  it.el.style.top = t + 'px';
}

function labelText(col: HTMLElement): string {
  const c = col.querySelector('.content');
  const t = (c?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 20 ? t.slice(0, 20) + '…' : t;
}

function firstLine(col: HTMLElement, max: number): string {
  const c = col.querySelector('.content');
  const t = (c?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** user 条目：其后第一条 assistant 的内容（预览「回复」段）。 */
function nextReplyText(it: RailItem): string {
  const i = items.indexOf(it);
  if (i < 0) return '';
  for (let k = i + 1; k < items.length; k++) {
    if (items[k]!.role === 'assistant') return firstLine(items[k]!.col, PREVIEW_CHARS);
  }
  return '';
}

// ---- 预览卡片 --------------------------------------------------------------------

function removeCard(): void {
  const card = msgsEl?.querySelector('.msgrail-card');
  if (card) card.remove();
}

function positionCard(it: RailItem): void {
  const card = msgsEl?.querySelector<HTMLElement>('.msgrail-card');
  if (card) card.style.top = it.top + 'px';
}

function showCard(it: RailItem): void {
  if (!msgsEl) return;
  removeCard();
  const card = el('div', 'msgrail-card');
  card.style.top = it.top + 'px';
  const q = firstLine(it.col, PREVIEW_CHARS);
  if (q) {
    const ql = el('div', 'msgrail-card-q');
    ql.appendChild(el('span', 'msgrail-card-tag', it.role === 'user' ? 'Q' : '回复'));
    ql.appendChild(el('span', null, q));
    card.appendChild(ql);
  }
  if (it.role === 'user') {
    const a = nextReplyText(it);
    if (a) {
      card.appendChild(el('div', 'msgrail-card-sep'));
      const al = el('div', 'msgrail-card-a');
      al.appendChild(el('span', 'msgrail-card-tag', 'A'));
      al.appendChild(el('span', null, a));
      card.appendChild(al);
    }
  }
  msgsEl.appendChild(card);
}

// ---- 交互（邻近度 + hover 停留预览） ----------------------------------------------

function setGrow(it: RailItem, g: number): void {
  it.el.style.setProperty('--grow', g.toFixed(3));
}

function onMove(e: MouseEvent): void {
  if (!msgsEl || !items.length) return;
  const rect = msgsEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x > RAIL_HIT) {
    // 鼠标离开 rail 区域：全部缩回细条
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const it of items) setGrow(it, 0);
    });
    return;
  }
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const baseY = msgsEl!.getBoundingClientRect().top;
    const scrollTop = msgsEl!.scrollTop;
    for (const it of items) {
      const y = baseY + it.top - scrollTop;
      const dist = Math.abs(e.clientY - (y + ITEM_H / 2));
      setGrow(it, Math.max(0, 1 - dist / GROW_RANGE));
    }
  });
}

function onLeave(): void {
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverItem = null;
  removeCard();
  for (const it of items) setGrow(it, 0);
}

/** 装配（main.ts 调用一次；幂等）。 */
export function initRail(): void {
  msgsEl = document.getElementById('messages');
  if (!msgsEl) return;
  ensureTrack();
  msgsEl.addEventListener('mousemove', onMove);
  msgsEl.addEventListener('mouseleave', onLeave);
  msgsEl.addEventListener('mouseover', (e) => {
    const t = e.target instanceof Element ? (e.target as Element).closest('.msgrail-item') : null;
    if (!t || !msgsEl?.contains(t)) return;
    const it = items.find((x) => x.el === t);
    if (!it) return;
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    hoverItem = it;
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null;
      showCard(it);
    }, PREVIEW_MS);
  });
  msgsEl.addEventListener('mouseout', (e) => {
    const t = e.target instanceof Element ? (e.target as Element).closest('.msgrail-item') : null;
    const rt = e.relatedTarget instanceof Element ? (e.relatedTarget as Element).closest('.msgrail-item') : null;
    if (t && t !== rt) {
      // 离开条目：关闭预览
      const it = items.find((x) => x.el === t);
      if (it && hoverItem === it) {
        if (hoverTimer !== null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        hoverItem = null;
        removeCard();
      }
    }
  });
}
