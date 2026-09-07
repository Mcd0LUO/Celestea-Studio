// ============================================================================
// ui/rail.ts — 「灵动消息选择条」v3（W238 删旧重做）
// ----------------------------------------------------------------------------
// ★ 锚定策略（与 v1/v2 的本质区别 —— 锚定于聊天区左侧留白带、不贴消息列）：
//   1) 轨道不再挂进滚动容器 #messages，而是以 position:absolute 固定在
//      聊天主区 #main（由 styles/rail.css 设 position:relative）内，几何上
//      与 #messages 视口严格重合（top/height 实时同步），left 固定在
//      #main 左缘内侧 8px —— 即「侧栏 + 拖宽分隔条」右侧的留白带最左端。
//      #messages 滚动时轨道纹丝不动 → 不随消息滚动而移动。
//   2) 横向坐标策略：留白带宽 gw = .mcol 左缘 − #main 左缘（= #messages
//      内边距 + mcol 居中的富余宽度）。长条自留白带左端向右生长，最长
//      min(110, gw−26)，即永远在 .mcol 左缘前 ≥18px 收住 → 不贴消息列
//      边缘、不遮消息内容（悬停/点击不会碰到消息气泡）。
//   3) 侧栏拖宽 / 窗口缩放 → ResizeObserver(#main,#messages) 重算几何：
//      gw ≥ 64px 正常态；24–64px 细条化（更短更细、仍可交互）；
//      < 24px 整体隐藏。任何档位都不溢出留白带。
// ★ 纵向排列方案（「垂直居中于视口 / 跟随可见区域」二选一，取前者为主）：
//   默认「垂直居中于视口」——长条按消息顺序自顶向下紧凑排列（自然节距
//   15px = 条高 12px + 间隙 3px；条数增多时节距自适应压缩、下限 5px），
//   条组整体垂直居中于消息视口。会话极长（最小节距仍放不下）时自动切换
//   「跟随可见区域」子集模式：只渲染当前视口附近的条目并随滚动实时刷新，
//   条组仍垂直居中。选固定条组而非逐消息贴位，是让长条 Y 与消息高度解耦：
//   流式输出期间消息高度变化不会拉扯选择条（位置/计数同步 = railSync
//   重排 + 新增消息即新增长条）。
// ★ 灵动交互：鼠标进入条带（x∈[轨道左−6, 轨道右+14]，y∈消息视口）→
//   距鼠标最近的长条权重 1（最长、吸附），上下邻居按 |Δy| 线性衰减
//   （fisheye）；hover 停留 350ms 弹预览卡（该消息首行前 40 字 + 分割线
//   + 助手回复首行前 40 字，数据全部取自已渲染消息 DOM，零网络请求）；
//   点击长条 → scrollIntoView 平滑定位到对应消息。交互统一由 #main 级
//   监听 + 命中判定完成（节距压缩后条高可到 3px，DOM 级 hover 不可靠）。
// ============================================================================
import { el } from '../utils/dom';

// ---- 紧凑几何（条高 10–14px、间隙 2–4px、视觉轻盈） ----
const ITEM_H = 12;             // 自然条高（节距 15px 时）
const GAP = 3;                 // 自然间隙
const PITCH_NATURAL = ITEM_H + GAP; // 15px
const PITCH_MIN = 5;           // 压缩节距下限（条 3px + 间隙 2px）
const PAD_Y = 8;               // 条组上下留白
const BASE_W = 7;              // 未悬停细条宽
const MAX_W = 110;             // 正常态最长条宽上限
const GUTTER_NORMAL = 64;      // 留白 ≥ 此值：正常态
const GUTTER_HIDE = 24;        // 留白 < 此值：隐藏
const RANGE = 160;             // fisheye 纵向衰减半径（px）
const PREVIEW_MS = 350;        // hover 停留防抖
const PREVIEW_CHARS = 40;      // 预览首行前 N 字

interface RailItem {
  col: HTMLElement;
  role: 'user' | 'assistant';
  el: HTMLElement;
  y: number;        // 长条中心在轨道内的 Y（layout 计算）
  w: number;        // 当前目标宽度（fisheye）
  visible: boolean;
}

let mainEl: HTMLElement | null = null;
let msgsEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let card: HTMLElement | null = null;
let items: RailItem[] = [];
let hoverItem: RailItem | null = null;
let hoverTimer: number | null = null;
let syncQueued = false;
let moveQueued = false;
let moveX = -1;
let moveY = -1;

// 几何缓存（layout() 刷新；pointer 命中判定直接读，避免每帧 reflow）
let railX = 8;
let railTop = 0;
let railH = 0;
let railW = MAX_W; // 当前档位的最大条宽
let pitch = PITCH_NATURAL;
let modeAll = true;

// ---- 轨道与几何 ---------------------------------------------------------------

function ensureTrack(): boolean {
  if (!mainEl) return false;
  if (!track || !track.isConnected) {
    track = document.createElement('div');
    track.className = 'railv3';
    mainEl.appendChild(track);
  }
  return true;
}

/** 留白带宽：.mcol 左缘 − #main 左缘（mcol 居中富余 + #messages 内边距）。 */
function gutterWidth(): number {
  if (!mainEl || !msgsEl) return 0;
  const col = msgsEl.querySelector<HTMLElement>('.mcol');
  const m = mainEl.getBoundingClientRect();
  if (!col) return Math.max(0, m.width - 24);
  return Math.max(0, col.getBoundingClientRect().left - m.left);
}

/** 全量重排：横向档位 + 纵向节距 + 条组居中（railSync / 滚动 / 尺寸变化）。 */
function layout(): void {
  if (!mainEl || !msgsEl || !track) return;
  const m = mainEl.getBoundingClientRect();
  const v = msgsEl.getBoundingClientRect();
  railTop = Math.max(0, v.top - m.top);
  railH = v.height;

  // ---- 横向：留白带档位（正常 / 细条化 / 隐藏） ----
  const gw = gutterWidth();
  if (gw < GUTTER_HIDE) {
    track.style.display = 'none';
    railW = 0;
    syncCard();
    return;
  }
  track.style.display = '';
  const thin = gw < GUTTER_NORMAL;
  railX = 8;
  railW = thin ? Math.max(6, gw - 24) : Math.min(MAX_W, gw - 26);
  track.classList.toggle('railv3-thin', thin);
  track.style.left = railX + 'px';
  track.style.top = railTop + 'px';
  track.style.height = railH + 'px';

  // ---- 纵向：节距自适应；超长会话切「跟随可见区域」子集 ----
  const usable = Math.max(0, railH - 2 * PAD_Y);
  const count = items.length;
  if (count === 0) {
    syncCard();
    return;
  }
  let shown: RailItem[];
  if (count * PITCH_MIN <= usable) {
    modeAll = true;
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / count));
    shown = items;
  } else {
    modeAll = false;
    shown = viewWindow();
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / Math.max(1, shown.length)));
  }
  const stripTop = PAD_Y + Math.max(0, (usable - shown.length * pitch) / 2);
  const barH = Math.max(3, pitch - GAP);
  for (const it of items) {
    const i = shown.indexOf(it);
    if (i < 0) {
      it.visible = false;
      it.el.style.display = 'none';
      continue;
    }
    it.visible = true;
    it.el.style.display = '';
    it.y = stripTop + i * pitch + pitch / 2;
    it.el.style.top = (it.y - barH / 2) + 'px';
    it.el.style.height = barH + 'px';
  }
  syncCard();
}

/** 消息列中心在滚动内容里的 Y（rect 法，不依赖 offsetParent）。 */
function docCenterY(it: RailItem): number {
  const v = msgsEl!.getBoundingClientRect();
  const c = it.col.getBoundingClientRect();
  return c.top - v.top + msgsEl!.scrollTop + c.height / 2;
}

/** 超长会话：只渲染视口上下各 ~0.2 屏范围内的条目（跟随可见区域）。 */
function viewWindow(): RailItem[] {
  const st = msgsEl!.scrollTop;
  const lo = st - railH * 0.2;
  const hi = st + railH * 1.2;
  return items.filter((it) => {
    const y = docCenterY(it);
    return y >= lo && y <= hi;
  });
}

// ---- 预览卡片（数据取自 DOM，零请求） -------------------------------------------

function removeCard(): void {
  if (card) {
    card.remove();
    card = null;
  }
}

/** 消息内容首行前 N 字（压平空白、取第一个非空行）。 */
function firstLine(col: HTMLElement): string {
  const c = col.querySelector('.content');
  const raw = (c?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!raw) return '';
  const line = raw.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) + '…' : line;
}

/** user 条目预览的「回复」段：其后第一条 assistant 的内容首行。 */
function nextReplyText(it: RailItem): string {
  const i = items.indexOf(it);
  for (let k = i + 1; k < items.length; k++) {
    if (items[k]!.role === 'assistant') return firstLine(items[k]!.col);
  }
  return '';
}

function showCard(it: RailItem): void {
  if (!mainEl || !it.visible) return;
  removeCard();
  card = el('div', 'railv3-card');
  const q = firstLine(it.col);
  if (q) {
    const ql = el('div', 'railv3-card-q');
    ql.appendChild(el('span', 'railv3-card-tag', it.role === 'user' ? 'Q' : '回复'));
    ql.appendChild(el('span', null, q));
    card.appendChild(ql);
  }
  if (it.role === 'user') {
    const a = nextReplyText(it);
    if (a) {
      card.appendChild(el('div', 'railv3-card-sep'));
      const al = el('div', 'railv3-card-a');
      al.appendChild(el('span', 'railv3-card-tag', 'A'));
      al.appendChild(el('span', null, a));
      card.appendChild(al);
    }
  }
  mainEl.appendChild(card);
  positionCard(it);
}

/** 预览卡锚在悬停长条右侧，纵向夹在消息视口内、横向不出主区。 */
function positionCard(it: RailItem): void {
  if (!card || !mainEl) return;
  const m = mainEl.getBoundingClientRect();
  const ch = card.offsetHeight;
  const lo = Math.min(railTop + 4, Math.max(railTop + 4, railTop + railH - ch - 4));
  const top = Math.min(Math.max(railTop + 4, railTop + it.y - ch / 2), lo);
  card.style.top = top + 'px';
  card.style.left = Math.min(railX + it.w + 8, m.width - 288) + 'px';
}

/** layout 后同步预览卡（悬停条被重排/隐藏时跟随或关闭）。 */
function syncCard(): void {
  if (!card) return;
  if (!hoverItem || !hoverItem.visible) {
    removeCard();
    return;
  }
  positionCard(hoverItem);
}

// ---- 交互（fisheye + hover 停留预览 + 点击定位） --------------------------------

function setGrow(it: RailItem, g: number): void {
  const w = BASE_W + Math.max(0, Math.min(1, g)) * Math.max(0, railW - BASE_W);
  if (Math.abs(w - it.w) < 0.1 && it.el.style.width !== '') return;
  it.w = w;
  it.el.style.width = w.toFixed(1) + 'px';
}

function clearHover(): void {
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverItem = null;
  removeCard();
  for (const it of items) it.el.classList.remove('is-hover');
}

/** 离开条带：全部收为细条（CSS transition 平滑回缩）。 */
function collapse(): void {
  clearHover();
  for (const it of items) setGrow(it, 0);
}

function onMove(e: PointerEvent): void {
  moveX = e.clientX;
  moveY = e.clientY;
  if (moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    applyMove();
  });
}

function applyMove(): void {
  if (!mainEl || !track || !items.length) {
    collapse();
    return;
  }
  const m = mainEl.getBoundingClientRect();
  const x = moveX - m.left;
  const y = moveY - m.top;
  const inZone =
    railW > 0 &&
    x >= railX - 6 &&
    x <= railX + railW + 14 &&
    y >= railTop &&
    y <= railTop + railH;
  if (!inZone) {
    collapse();
    return;
  }
  const hitR = Math.max(pitch / 2, 8); // 压缩节距下保持 ≥8px 命中半径
  let best: RailItem | null = null;
  let bestD = Infinity;
  for (const it of items) {
    if (!it.visible) continue;
    const d = Math.abs(y - (railTop + it.y));
    setGrow(it, 1 - d / RANGE); // 邻近度权重线性衰减（fisheye）
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  const hit = best !== null && bestD <= hitR ? best : null;
  if (hit) {
    setGrow(hit, 1); // 吸附：最近者拉满
    if (hoverItem !== hit) {
      if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      removeCard();
      hoverItem = hit;
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverItem) showCard(hoverItem);
      }, PREVIEW_MS);
    }
  } else {
    clearHover();
  }
  // 高亮类最后统一打（避免 clearHover 把新命中条的高亮抹掉）
  for (const it of items) it.el.classList.toggle('is-hover', it === hit);
}

function onLeave(): void {
  collapse();
}

function onClick(e: MouseEvent): void {
  if (!mainEl || !hoverItem) return;
  const m = mainEl.getBoundingClientRect();
  const x = e.clientX - m.left;
  const y = e.clientY - m.top;
  if (x < railX - 6 || x > railX + railW + 14 || y < railTop || y > railTop + railH) return;
  if (Math.abs(y - (railTop + hoverItem.y)) > Math.max(pitch / 2, 8)) return;
  e.preventDefault();
  hoverItem.col.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onScroll(): void {
  if (modeAll) return;
  queueSync(); // 超长会话：滚动刷新「跟随可见区域」子集
}

// ---- 对外 API（messages.ts / main.ts 接线；main.ts 调用一次） --------------------

function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    layout();
  });
}

/** 创建消息时注册一根长条（addUserMessage / ensureAssistant 调用）。 */
export function railAdd(col: HTMLElement, role: 'user' | 'assistant'): void {
  if (!ensureTrack() || !track) return;
  const bar = document.createElement('div');
  bar.className = 'railv3-item' + (role === 'assistant' ? ' is-reply' : '');
  track.appendChild(bar);
  items.push({ col, role, el: bar, y: 0, w: BASE_W, visible: false });
  layout();
}

/** 清空会话时调用：移除全部长条并复位交互状态（轨道元素常驻 #main）。 */
export function railReset(): void {
  items = [];
  clearHover();
  if (track) track.textContent = '';
}

/** 聊天区重渲染后同步（流式钩子：重排 + 新增长条计数，rAF 节流）。 */
export function railSync(): void {
  queueSync();
}

/** 装配（幂等）。 */
export function initRail(): void {
  if (mainEl) return;
  mainEl = document.getElementById('main');
  msgsEl = document.getElementById('messages');
  if (!mainEl || !msgsEl) return;
  ensureTrack();
  layout();

  mainEl.addEventListener('pointermove', onMove);
  mainEl.addEventListener('pointerleave', onLeave);
  mainEl.addEventListener('click', onClick);
  msgsEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', queueSync);

  const ro = new ResizeObserver(queueSync);
  ro.observe(mainEl);
  ro.observe(msgsEl);
}
