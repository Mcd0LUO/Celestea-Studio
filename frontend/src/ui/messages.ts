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
import type { AssistantView, StreamDom } from './view';
import type { SessionPane } from './viewctx';
import { railAdd, railSync } from './rail';

// ---- markdown ---------------------------------------------------------------
/** Render markdown to safe-enough HTML（历史恢复/一次性渲染路径）。 */
export function md(text: string): string {
  return renderMarkdown(text);
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

/** 离屏解析 HTML 片段为节点数组（不挂载；供单次替换用）。 */
function htmlToNodes(html: string): Node[] {
  if (!html) return [];
  const off = document.createElement('div');
  off.innerHTML = html;
  return Array.from(off.childNodes);
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

/** 轮次结束/新轮开始：清除思考段归属与文本段锚点（跨轮不跨移；DOM 保留）。 */
export function endTurn(ctx: SessionPane): void {
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
}

/**
 * Append a thinking delta（弱化块：左侧色条 + 浅色底 + 小字；独立成段）。
 * 重排规则：思考块的目标位置 = 同轮最近文本块的正上方（紧贴）；已在目标
 * 之前则不动。跨轮：endTurn() 清 thinkSeg/lastTextCol，绝不串位。
 */
export function appendThinking(ctx: SessionPane, delta: string): void {
  if (!ctx.thinkSeg) {
    hideEmptyHint(ctx);
    const root = el('div', 'mcol');
    const msg = el('div', 'msg think-seg');
    const cap = el('div', 'msg-caption think-head') as HTMLElement;
    cap.appendChild(el('span', 'who', '思考'));
    const foldMark = el('span', 'think-fold-mark', '▾');
    cap.appendChild(foldMark);
    cap.appendChild(el('span', 'think-time', fmtNow()));
    msg.appendChild(cap);
    const bubble = el('div', 'bubble think-seg-bubble');
    const body = el('div', 'think-seg-body');
    bubble.appendChild(body);
    const folded = el('div', 'think-seg-folded', '思考已折叠，点击展开');
    bubble.appendChild(folded);
    msg.appendChild(bubble);
    root.appendChild(msg);
    ctx.el.appendChild(root);
    const seg = { root, head: cap, body, text: '' };
    ctx.thinkSeg = seg;
    body.textContent = '思考中…'; // 流式思考占位态（弱化）
    cap.addEventListener('click', () => {
      const cur = ctx.thinkSeg;
      if (cur !== null && ctx.streaming) return; // 流式思考中不折叠
      root.classList.toggle('collapsed');
      foldMark.textContent = root.classList.contains('collapsed') ? '▸' : '▾';
    });
  }
  const seg = ctx.thinkSeg;
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
