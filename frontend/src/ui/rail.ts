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

// ---- 紧凑几何（第 16 轮：细条 —— 自然高 5px、间隙 4px；hover 不变长不变粗） ----
const ITEM_H = 5;              // 自然条高（hover 保持）
const GAP = 4;                 // 自然间隙
const PITCH_NATURAL = ITEM_H + GAP; // 9px
const PITCH_MIN = 4;           // 压缩节距下限（条 2px + 间隙 2px）
const PAD_Y = 8;               // 条组上下留白
const BASE_W = 7;              // 未悬停细条宽
const MAX_W = 110;             // 正常态最长条宽上限
const GUTTER_NORMAL = 64;      // 留白 ≥ 此值：正常态
const GUTTER_HIDE = 24;        // 留白 < 此值：隐藏
const RANGE = 160;             // fisheye 纵向衰减半径（px）
const PREVIEW_MS = 350;        // hover 停留防抖
const PREVIEW_CHARS = 40;      // 预览首行前 N 字
const MAX_ROWS = 20;           // 轮条显示上限：只显示最近 20 轮，更早折叠为顶部「⋯」

/** 一根长条 = 一轮（一问一答合并）：user 消息与其后 assistant 回复（含工具活动）。 */
interface RailItem {
  startCol: HTMLElement; // 轮起点（user 消息；孤立 assistant 为其自身）
  cols: HTMLElement[];   // 该轮全部消息列（user + assistant 段）
  hasReply: boolean;     // 该轮是否已有 assistant 回复
  el: HTMLElement;
  y: number;             // 长条中心在轨道内的 Y（layout 计算）
  visible: boolean;
  fold: number;          // >0 = 折叠条（表示更早 N 轮已折叠）
}

let mainEl: HTMLElement | null = null;
let msgsEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let card: HTMLElement | null = null;
let items: RailItem[] = [];
let foldItem: RailItem | null = null; // 「更早 N 轮已折叠」顶部短条（items 之外）
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

/** 参与布局/交互的全部条目（含折叠条）。 */
function allItems(): RailItem[] {
  return foldItem ? [foldItem, ...items] : items;
}

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

  // ---- 纵向：节距自适应；轮条上限 20 + 顶部折叠条 ----
  const usable = Math.max(0, railH - 2 * PAD_Y);
  if (items.length === 0) {
    if (foldItem) {
      foldItem.el.remove();
      foldItem = null;
    }
    syncCard();
    return;
  }
  // 折叠条：超过 MAX_ROWS 轮 → 旧轮折叠为顶部「⋯」短条
  const foldN = items.length > MAX_ROWS ? items.length - MAX_ROWS : 0;
  if (foldN > 0) {
    if (!foldItem || !foldItem.el.isConnected) {
      foldItem = {
        startCol: items[items.length - MAX_ROWS]!.startCol,
        cols: [],
        hasReply: false,
        el: document.createElement('div'),
        y: 0,
        visible: false,
        fold: foldN,
      };
      foldItem.el.className = 'railv3-item railv3-fold';
      foldItem.el.textContent = '⋯';
      foldItem.el.title = '更早的 ' + foldN + ' 轮已折叠';
      track!.appendChild(foldItem.el);
    }
    foldItem.fold = foldN;
  } else if (foldItem) {
    foldItem.el.remove();
    foldItem = null;
  }
  const bars = allItems();
  const count = bars.length;
  let shown: RailItem[];
  if (count * PITCH_MIN <= usable) {
    modeAll = true;
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / count));
    shown = bars;
  } else {
    modeAll = false;
    shown = viewWindow();
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / Math.max(1, shown.length)));
  }
  const stripTop = PAD_Y + Math.max(0, (usable - shown.length * pitch) / 2);
  const barH = Math.max(2, pitch - GAP);
  for (const it of bars) {
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
    it.el.style.setProperty('--barh', barH + 'px'); // 高度经 CSS 变量，hover 可加高
  }
  syncCard();
}

/** 消息列中心在滚动内容里的 Y（rect 法，不依赖 offsetParent）。 */
function docCenterY(it: RailItem): number {
  const v = msgsEl!.getBoundingClientRect();
  const c = it.startCol.getBoundingClientRect();
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

/** 该轮第一条 assistant 回复的内容首行（轮内查找，不跨轮）。 */
function replyLine(it: RailItem): string {
  for (const col of it.cols) {
    if (col.querySelector('.msg.assistant')) return firstLine(col);
  }
  return '';
}

function showCard(it: RailItem): void {
  if (!mainEl || !it.visible) return;
  removeCard();
  card = el('div', 'railv3-card');
  if (it.fold > 0) {
    // 折叠条：hover 提示更早轮数
    const ql = el('div', 'railv3-card-q');
    ql.appendChild(el('span', 'railv3-card-tag', '⋯'));
    ql.appendChild(el('span', null, '更早的 ' + it.fold + ' 轮已折叠'));
    card.appendChild(ql);
  } else {
    const q = firstLine(it.startCol);
    if (q) {
      const ql = el('div', 'railv3-card-q');
      ql.appendChild(el('span', 'railv3-card-tag', 'Q'));
      ql.appendChild(el('span', null, q));
      card.appendChild(ql);
    }
    if (it.hasReply) {
      const a = replyLine(it);
      if (a) {
        card.appendChild(el('div', 'railv3-card-sep'));
        const al = el('div', 'railv3-card-a');
        al.appendChild(el('span', 'railv3-card-tag', 'A'));
        al.appendChild(el('span', null, a));
        card.appendChild(al);
      }
      // 流式回复进行中（hasReply 但尚无内容）：不显示 A 行
    } else {
      card.appendChild(el('div', 'railv3-card-sep'));
      const al = el('div', 'railv3-card-a railv3-card-noa');
      al.appendChild(el('span', 'railv3-card-tag', 'A'));
      al.appendChild(el('span', null, '（无回复）'));
      card.appendChild(al);
    }
  }
  mainEl.appendChild(card);
  positionCard(it);
}

/** 预览锚定（第 18 轮）：必须出现在被 hover 细条的右侧、与该条同一垂直位置——
 *  top = 条 getBoundingClientRect().top（相对 #main），x = 条右缘 + 8px；
 *  越界（太靠下）向上收，横向不出主区。流式高度变化时条移动 → railSync →
 *  layout → syncCard 重新调用本函数，预览跟随该条。 */
function positionCard(it: RailItem): void {
  if (!card || !mainEl) return;
  const m = mainEl.getBoundingClientRect();
  const r = it.el.getBoundingClientRect();
  const ch = card.offsetHeight;
  // 同一垂直位置：按条 top 对齐；越界上下收（默认向上收）
  let top = r.top - m.top;
  top = Math.max(railTop + 4, Math.min(top, railTop + railH - ch - 4));
  // x = 条右缘 + 8px；越界右收进主区
  const left = Math.min(r.right - m.left + 8, m.width - 288);
  card.style.top = top + 'px';
  card.style.left = Math.max(railX + 4, left) + 'px';
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

/** 第 18 轮：恢复「变长」——水平长度 fisheye（Codex 式：临近者最长、
 *  两侧按邻近度线性递减），细条高度保持 5px 不变（绝不加粗加高）；
 *  变长为主、微亮为辅：opacity 0.35→0.7 随同一权重。 */
function setGrow(it: RailItem, g: number): void {
  const k = Math.max(0, Math.min(1, g));
  const w = BASE_W + k * Math.max(0, railW - BASE_W);
  it.el.style.width = w.toFixed(1) + 'px';
  it.el.style.opacity = (0.35 + 0.35 * k).toFixed(3);
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
  for (const it of allItems()) setGrow(it, 0);
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
  for (const it of allItems()) {
    if (!it.visible) continue;
    const d = Math.abs(y - (railTop + it.y));
    setGrow(it, 1 - d / RANGE); // 变长 fisheye + 微亮（线性衰减，RANGE=160px）
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  const hit = best !== null && bestD <= hitR ? best : null;
  if (hit) {
    setGrow(hit, 1); // 吸附：最近者拉满（最长+全亮）
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
  for (const it of allItems()) it.el.classList.toggle('is-hover', it === hit);
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
  // 折叠条 → 定位到最早可见轮；普通条 → 定位到该轮起点（一问一答的第一条）
  hoverItem.startCol.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/** 注册一根轮条（addUserMessage / ensureAssistant 调用；第 15 轮：一问一答合并）。
 *  user 消息 = 新轮起点；assistant 段合并进最近一轮（含流式未收尾），
 *  工具活动随其轮内不单独成条。孤立 assistant（恢复历史首条）自成一轮。 */
export function railAdd(col: HTMLElement, role: 'user' | 'assistant'): void {
  if (!ensureTrack() || !track) return;
  const last = items[items.length - 1];
  if (role === 'user' || !last) {
    const bar = document.createElement('div');
    bar.className = 'railv3-item' + (role === 'assistant' ? ' is-reply' : '');
    track.appendChild(bar);
    items.push({ startCol: col, cols: [col], hasReply: role === 'assistant', el: bar, y: 0, visible: false, fold: 0 });
  } else {
    // 合并进最近一轮（一问一答一根条）
    last.cols.push(col);
    if (!last.hasReply) {
      last.hasReply = true;
      last.el.classList.add('is-reply');
    }
  }
  layout();
}

/** 清空会话时调用：移除全部长条并复位交互状态（轨道元素常驻 #main）。 */
export function railReset(): void {
  items = [];
  foldItem = null;
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
