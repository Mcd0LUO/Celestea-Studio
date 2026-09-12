// ============================================================================
// ui/messages.ts — 消息流（单一职责，W240 连续事件流重构；W514 多会话化）：
//   一轮 = 按事件真实时间顺序渲染成一条连续流：
//     用户消息 → 思考段（弱化块，按序）→ 文本段（markdown 气泡）→
//     工具调用卡（内联条目）→ 工具结果 → 继续文本段 → ……
//   文本增量按节拍重渲染；工具事件到达时当前文本段收尾（flushTextSegment），
//   后续文本开启新段 —— 不再按"思考/文本/工具"分区聚合。
//   W301：文本段改用 MarkdownStream 增量渲染（只解析未固化尾部）。
//   W514：所有渲染目标由「全局 #messages」改为「会话视图容器 SessionPane」——
//         每个会话各有一份流式状态（assistant/thinkSeg/渲染节拍），后台会话的
//         增量渲染进它自己的隐藏容器，不触碰当前视图（零重渲染、无空白帧）。
// ============================================================================
import { el, fmtNow } from '../utils/dom';
import { highlightCode } from '../utils/hljs';
import { MarkdownStream, renderMarkdown } from '../utils/markdown';
import { sanitizeHtml, sanitizeNodes } from '../utils/sanitize';
import type { AssistantView, StreamDom } from './view';
import type { SessionPane } from './viewctx';
import { railAdd, railSync } from './rail';

// ---- markdown ---------------------------------------------------------------
/**
 * Render markdown to **sanitized** HTML（历史恢复/一次性渲染路径）。
 * W739：返回值已过 utils/sanitize 白名单消毒（模型输出属不可信输入），
 * 可直接写入 DOM；需要节点时同样先走 sanitizeNodes。
 */
export function md(text: string): string {
  return sanitizeHtml(renderMarkdown(text));
}

// ---- 文本段增量渲染器（W301） ---------------------------------------------------
/** 每个 AssistantView 一份流式渲染状态（WeakMap 挂载，不改 view.ts 公共接口）。 */
const doms = new WeakMap<AssistantView, StreamDom>();

function domOf(view: AssistantView): StreamDom {
  let d = doms.get(view);
  if (!d) {
    d = {
      stream: new MarkdownStream(),
      stableNodes: [],
      tailNodes: [],
      lastText: '\u0000',
      inited: false,
    };
    doms.set(view, d);
  }
  return d;
}

/**
 * markdown 渲染产物 → 安全节点数组（不挂载；供单次替换用）。
 * W739：HTML 一律经 utils/sanitize 白名单消毒后再进 DOM —— 本函数是渲染产物
 * 变成真实节点的**唯一**通道（模型正文 / 工具结果 / 会话历史都走它），
 * 解析在惰性文档里完成（脚本不执行、资源不加载）。
 */
function htmlToNodes(html: string): Node[] {
  return sanitizeNodes(html);
}

// ---- scrolling ----------------------------------------------------------------
/**
 * 粘性自动滚动：仅在用户接近底部时跟随；force 用于完成/新消息时。
 * W514：只作用于该会话自己的容器；后台（隐藏）容器不写布局——只记录
 * 「期望贴底」，切回时由 viewctx 恢复滚动位。
 */
export function autoscroll(ctx: SessionPane, force = false): void {
  if (ctx.el.hidden) {
    if (force) ctx.stickBottom = true;
    return;
  }
  const nearBottom = ctx.el.scrollTop + ctx.el.clientHeight >= ctx.el.scrollHeight - 200;
  if (force || nearBottom) ctx.el.scrollTop = ctx.el.scrollHeight;
}

export function hideEmptyHint(ctx: SessionPane): void {
  ctx.hint.classList.add('hidden');
}

/** Rebuild the empty state exactly as it shipped in index.html（容器级）。 */
export function renderEmptyHint(ctx: SessionPane): void {
  ctx.el.replaceChildren();
  const hint = el('div', 'empty-hint empty-hint-fresh');
  hint.appendChild(el('div', 'empty-mark', '◇'));
  hint.appendChild(el('div', 'empty-title', 'Celestea Studio'));
  hint.appendChild(
    el('div', 'empty-sub', '在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行'),
  );
  ctx.el.appendChild(hint);
  ctx.hint = hint;
}

/** 助手文本段是否已有内容（占位判定）。 */
export function assistantHasContent(view: AssistantView): boolean {
  return view.text.trim() !== '' || view.content.childElementCount > 0;
}

/** 直接移除空占位助手气泡（不渲染空块）。 */
export function removeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.root.remove();
  doms.delete(view);
  if (ctx.assistant === view) ctx.assistant = null;
}

/** 清空该会话消息流并重建空态（/api/clear 成功后调用；同时重置流式状态）。 */
export function resetMessages(ctx: SessionPane): void {
  if (ctx.renderTimer !== null) {
    window.clearTimeout(ctx.renderTimer);
    ctx.renderTimer = null;
  }
  if (ctx.assistant) doms.delete(ctx.assistant);
  ctx.assistant = null;
  ctx.turn = null;
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
  ctx.interjectNote = null;
  ctx.ops.clear();
  ctx.step = 0;
  renderEmptyHint(ctx);
}

// ---- 流式正文渲染节流 ---------------------------------------------------------
const RENDER_INTERVAL = 60; // ms —— 重渲染节拍（兼顾流畅与 CPU）

/**
 * 增量渲染文本段（W301 + W514 每容器独立节拍）：
 *   1) MarkdownStream 只解析「未固化尾部」，返回 stableHtml / tailHtml 分解；
 *   2) 新固化的块离屏构建后 append 到 content（已有块 DOM 原地保留）；
 *   3) 尾部节点离屏构建后**单次替换**（同一帧内完成，无空白帧）。
 */
function renderTextView(ctx: SessionPane, view: AssistantView): void {
  const d = domOf(view);
  if (d.lastText === view.text) {
    autoscroll(ctx);
    railSync(ctx);
    return;
  }
  const parts = d.stream.updateParts(view.text);
  d.lastText = view.text;

  if (parts.reset || !d.inited) {
    d.stableNodes = htmlToNodes(parts.stableHtml);
    d.tailNodes = htmlToNodes(parts.tailHtml);
    view.content.replaceChildren(...d.stableNodes, ...d.tailNodes);
    d.inited = true;
  } else {
    const anchor = d.tailNodes[0] ?? null;
    const place = (n: Node) => {
      if (anchor) view.content.insertBefore(n, anchor);
      else view.content.appendChild(n);
    };
    if (parts.stableDeltaHtml) {
      for (const n of htmlToNodes(parts.stableDeltaHtml)) {
        place(n);
        d.stableNodes.push(n);
      }
    }
    const freshTail = htmlToNodes(parts.tailHtml);
    for (const n of freshTail) place(n);
    for (const n of d.tailNodes) n.parentNode?.removeChild(n);
    d.tailNodes = freshTail;
  }

  highlightCode(view.content);
  autoscroll(ctx);
  railSync(ctx);
}

function scheduleTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.renderTimer !== null) return; // 已有一次节拍排队
  const wait = Math.max(0, ctx.renderDeadline + RENDER_INTERVAL - performance.now());
  ctx.renderTimer = window.setTimeout(() => {
    ctx.renderTimer = null;
    ctx.renderDeadline = performance.now();
    renderTextView(ctx, view);
  }, wait);
}

/** 立即冲刷（turn 结束 / done 事件 / 最终文本到来时调用）。 */
function flushTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.renderTimer !== null) {
    window.clearTimeout(ctx.renderTimer);
    ctx.renderTimer = null;
  }
  ctx.renderDeadline = performance.now();
  renderTextView(ctx, view);
}

/** 增量追加正文 delta（节拍渲染，不逐字重排）。 */
export function appendText(ctx: SessionPane, view: AssistantView, delta: string): void {
  view.text += delta || '';
  scheduleTextView(ctx, view);
}

/** Sync final assistant text from the done event. */
export function applyFinalText(ctx: SessionPane, view: AssistantView, text: string): void {
  if (typeof text !== 'string' || !text || view.text === text) return;
  view.text = text;
  flushTextView(ctx, view);
}

/** 冻结当前文本段：有内容则收尾为完整气泡，并解除当前段。 */
export function flushTextSegment(ctx: SessionPane): void {
  const a = ctx.assistant;
  if (!a) return;
  ctx.assistant = null;
  if (assistantHasContent(a)) {
    a.bubble.classList.remove('streaming');
    a.bubble.classList.add('complete');
    flushTextView(ctx, a);
    autoscroll(ctx, true);
  } else {
    a.root.remove(); // 空占位不渲染
    doms.delete(a);
  }
}

// ---- thinking（弱化独立段，按事件顺序出现，不再聚合进气泡） ----------------------

/* W752：思考段默认折叠。
 * 折叠类挂在 **.msg.think-seg** 上（不是 .mcol 根）——CSS 选择器是
 * `.msg.think-seg.collapsed …`；历史上 live 把类 toggle 到 .mcol 根上，选择器
 * 永不命中，于是「点了没反应、永远展开」。setThinkCollapsed 是折叠态的唯一写入口
 * （class + 箭头字形 + aria-expanded 三处同写）；live 追加与历史恢复共用
 * buildThinkSeg，两条路径的默认态因此不可能分叉。 */

/** 折叠（收起）标记字形。 */
export const THINK_MARK_COLLAPSED = '▸';
/** 展开标记字形。 */
export const THINK_MARK_EXPANDED = '▾';
/** 折叠占位行文案（收起时代替正文显示）。 */
export const THINK_FOLDED_HINT = '思考已折叠，点击展开';

/** 思考段的折叠零件（root = .mcol 容器）。 */
export interface ThinkSegDom {
  root: HTMLElement; // .mcol
  msg: HTMLElement; // .msg.think-seg（折叠类挂它，CSS 依赖）
  head: HTMLElement; // 标题行（点击 / 回车 / 空格切换）
  body: HTMLElement; // 正文
  foldMark: HTMLElement; // 折叠箭头
  text: string; // 累积思考文本（与 ui/view.ts 的 ThinkSeg 同字段，便于直接挂到 ctx）
}

/** root → 折叠零件（不改 ui/view.ts 的 ThinkSeg 合同）。 */
const thinkFolds = new WeakMap<HTMLElement, ThinkSegDom>();
/** 用户手动切换过折叠态的段：段结束的自动折叠不再覆盖用户意图。 */
const thinkUserFolded = new WeakSet<HTMLElement>();

/** 折叠态唯一写入口：class + 箭头 + aria-expanded 同步。 */
export function setThinkCollapsed(seg: ThinkSegDom, collapsed: boolean): void {
  seg.msg.classList.toggle('collapsed', collapsed);
  seg.foldMark.textContent = collapsed ? THINK_MARK_COLLAPSED : THINK_MARK_EXPANDED;
  seg.head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/**
 * 构建思考段 —— live 追加与历史恢复**共用这一处**（默认态的唯一真源）。
 * collapsed 缺省 = true（默认折叠）；只有 live 流式期间显式传 false 自动展开。
 */
export function buildThinkSeg(
  opts: { time?: string; text?: string; collapsed?: boolean } = {},
): ThinkSegDom {
  const root = el('div', 'mcol');
  const msg = el('div', 'msg think-seg');
  const cap = el('div', 'msg-caption think-head') as HTMLElement;
  cap.appendChild(el('span', 'who', '思考'));
  const foldMark = el('span', 'think-fold-mark', THINK_MARK_COLLAPSED);
  cap.appendChild(foldMark);
  cap.appendChild(el('span', 'think-time', opts.time ?? ''));
  cap.setAttribute('role', 'button');
  cap.setAttribute('aria-expanded', 'false');
  cap.tabIndex = 0;
  msg.appendChild(cap);
  const bubble = el('div', 'bubble think-seg-bubble');
  const body = el('div', 'think-seg-body');
  if (opts.text !== undefined) body.textContent = opts.text;
  bubble.appendChild(body);
  bubble.appendChild(el('div', 'think-seg-folded', THINK_FOLDED_HINT));
  msg.appendChild(bubble);
  root.appendChild(msg);
  const seg: ThinkSegDom = { root, msg, head: cap, body, foldMark, text: opts.text ?? '' };
  thinkFolds.set(root, seg);
  setThinkCollapsed(seg, opts.collapsed !== false);
  const toggle = (): void => {
    thinkUserFolded.add(seg.root); // 记下用户意图
    setThinkCollapsed(seg, !seg.msg.classList.contains('collapsed'));
  };
  cap.addEventListener('click', toggle);
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return seg;
}

/**
 * 段结束（流式结束 / 新轮开始）自动折叠回默认态；用户手动切换过则不打扰。
 * ctx.thinkSeg 的静态类型不含折叠零件，故用 root 反查登记表。
 */
export function foldThinkSeg(ctx: SessionPane): void {
  const seg = ctx.thinkSeg;
  if (!seg) return;
  const parts = thinkFolds.get(seg.root);
  if (!parts || thinkUserFolded.has(seg.root)) return;
  setThinkCollapsed(parts, true);
}

/** 轮次结束/新轮开始：思考段折回默认态，清除思考段归属与文本段锚点（DOM 保留）。 */
export function endTurn(ctx: SessionPane): void {
  foldThinkSeg(ctx); // W752：流式结束 → 思考段回到「默认折叠」终态
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
}

/**
 * Append a thinking delta（弱化块：左侧色条 + 浅色底 + 小字；独立成段）。
 * 重排规则：思考块的目标位置 = 同轮最近文本块的正上方（紧贴）；已在目标
 * 之前则不动。跨轮：endTurn() 清 thinkSeg/lastTextCol，绝不串位。
 * W752：默认折叠；创建时若本轮流式进行中则自动展开，流式结束自动折回折叠态。
 */
export function appendThinking(ctx: SessionPane, delta: string): void {
  if (!ctx.thinkSeg) {
    hideEmptyHint(ctx);
    // W752：默认折叠；仅当本轮流式进行中时自动展开（让用户实时看到思考内容），
    // 流式结束（endTurn / 新轮开始）自动折回默认态。
    const seg = buildThinkSeg({ time: fmtNow(), collapsed: !ctx.streaming });
    ctx.el.appendChild(seg.root);
    ctx.thinkSeg = seg;
    seg.body.textContent = '思考中…'; // 流式思考占位态（弱化）
  }
  const seg = ctx.thinkSeg;
  // W752：流式期间保持展开（用户手动收起的除外）——重连补发可能让本段先以折叠态
  // 建好，随后的增量不该悄悄写进看不见的折叠块里。
  if (seg && ctx.streaming && !thinkUserFolded.has(seg.root)) {
    const parts = thinkFolds.get(seg.root);
    if (parts && parts.msg.classList.contains('collapsed')) setThinkCollapsed(parts, false);
  }
  const target = ctx.assistant?.root ?? ctx.lastTextCol;
  if (
    seg !== null &&
    target &&
    seg.root.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
  ) {
    ctx.el.insertBefore(seg.root, target); // 紧贴目标上方
  }
  if (seg !== null) {
    seg.text += delta || '';
    seg.body.textContent = seg.text === '' ? '思考中…' : seg.text;
  }
  autoscroll(ctx);
  railSync(ctx);
}

// ---- 信息块（context/status 类事件：注入、lagged、error 提示等） ------------------

/** 渲染一条可见信息块（按序出现在流中；样式与普通消息区分：左侧色条 + 浅色底）。 */
export function renderInfoBlock(ctx: SessionPane, text: string, cls?: 'err' | 'warn'): void {
  if (!text) return;
  hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const msg = el('div', 'msg info' + (cls ? ' ' + cls : ''));
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '系统'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble info-bubble');
  const body = el('div', 'content info-content');
  body.textContent = text;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  ctx.el.appendChild(col);
  autoscroll(ctx, true);
}

// ---- message builders ----------------------------------------------------------

/**
 * W515 转录条目分类（对齐 DSH 的 user / steering / inbox）：
 *   user     —— 普通用户消息（聚焦会话空闲时发送，开新轮）
 *   steering —— 插话（运行中注入：DSH inbox 的 next-step 车道，最近 step 边界送达）
 *   queued   —— 排队（运行中提交、本轮结束后作为下一回合投递：next-turn 车道）
 *   inbox    —— 系统注入 / worker 回执（非用户输入，只读展示）
 */
export type MsgKind = 'user' | 'steering' | 'queued';

const USER_CAPTION: Record<MsgKind, string> = {
  user: '你',
  steering: '插话',
  queued: '排队',
};

/**
 * 用户侧消息（普通 / 插话 / 排队）。三类在样式与标题前缀上可区分，
 * 绝不与普通用户消息混同（W515 要求）。
 */
export function addUserMessage(
  ctx: SessionPane,
  text: string,
  opts?: { kind?: MsgKind; into?: HTMLElement },
): HTMLElement {
  const kind: MsgKind = opts?.kind ?? 'user';
  const target = opts?.into ?? ctx.el;
  if (target === ctx.el) hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const cls = kind === 'user' ? 'msg user' : 'msg user ' + kind + ' interject';
  const msg = el('div', cls);
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', USER_CAPTION[kind]));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content');
  body.textContent = text;
  body.style.whiteSpace = 'pre-wrap';
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  railAdd(ctx, col, kind === 'user' ? 'user' : 'interject');
  if (target === ctx.el) {
    railSync(ctx);
    autoscroll(ctx, true);
  }
  return col;
}

/**
 * inbox 条目（W515）：系统注入 / worker 回执等非用户输入，独立样式与
 * 「回执/系统」前缀，避免与用户消息或系统 info 块混同。
 * source 用于前缀（如 worker id）；缺省 → 「系统」。
 */
export function renderInboxMessage(
  ctx: SessionPane,
  text: string,
  opts?: { source?: string; target?: string; into?: HTMLElement },
): HTMLElement {
  const target = opts?.into ?? ctx.el;
  if (target === ctx.el) hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const msg = el('div', 'msg inbox');
  const cap = el('div', 'msg-caption');
  const src = (opts?.source ?? '').trim();
  cap.appendChild(el('span', 'who', src === '' ? '系统' : '回执 · ' + src));
  if (opts?.target) cap.appendChild(el('span', 'inbox-lane', laneLabel(opts.target)));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble inbox-bubble');
  const body = el('div', 'content inbox-content');
  body.textContent = text;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  if (target === ctx.el) {
    railSync(ctx);
    autoscroll(ctx, true);
  }
  return col;
}

/** DSH InboxTarget → 展示文案（缺省/未知车道 → 空）。 */
export function laneLabel(target: string): string {
  if (target === 'next-step') return '下一步送达';
  if (target === 'next-turn') return '下一回合送达';
  return '';
}

/**
 * 运行中插话的轻提示（贴在插话气泡下方；成功/失败各一态）。
 * 返回元素句柄，供结果到达后就地改文案（不重建列表）。
 */
export function renderInterjectNote(
  ctx: SessionPane,
  text: string,
  cls?: 'ok' | 'err',
  after?: HTMLElement | null,
): HTMLElement {
  const note = el('div', 'mcol interject-note-col');
  const msg = el('div', 'interject-note' + (cls ? ' ' + cls : ''), text);
  note.appendChild(msg);
  const anchor = after ?? null;
  if (anchor) anchor.after(note);
  else ctx.el.appendChild(note);
  if (anchor) {
    if (anchor.nextSibling === note) autoscroll(ctx, true);
  } else {
    autoscroll(ctx, true);
  }
  return msg;
}

/** 获取当前文本段视图或创建新的流式文本气泡（容器 = 该会话的视图）。 */
export function ensureAssistant(ctx: SessionPane, into?: HTMLElement): AssistantView {
  const target = into ?? ctx.el;
  if (target === ctx.el) {
    if (ctx.assistant) return ctx.assistant;
    hideEmptyHint(ctx);
  }
  const col = el('div', 'mcol');
  const msg = el('div', 'msg assistant');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', 'Studio'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble streaming');
  const content = el('div', 'content');
  bubble.appendChild(content);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  railAdd(ctx, col, 'assistant');
  if (target === ctx.el) railSync(ctx);

  // think/cards 字段为类型兼容保留（不挂载；thinking/工具卡均独立成段）
  const view: AssistantView = {
    root: msg,
    bubble,
    think: document.createElement('details'),
    thinkBody: document.createElement('div'),
    thinkTime: document.createElement('span'),
    cards: document.createElement('div'),
    content,
    text: '',
    thinkText: '',
    ops: new Map(),
    steps: 0,
  };
  if (target === ctx.el) {
    ctx.lastTextCol = col; // 同轮最近文本段（thinking 重排锚点）
    ctx.assistant = view;
    autoscroll(ctx, true);
  }
  return view;
}

/** 文本段收尾（turn 结束 / done 冲刷）。 */
export function finalizeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  flushTextView(ctx, view);
  autoscroll(ctx, true);
}
