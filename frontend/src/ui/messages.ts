// ============================================================================
// ui/messages.ts — 消息流（单一职责，W240 连续事件流重构）：
//   一轮 = 按事件真实时间顺序渲染成一条连续流：
//     用户消息 → 思考段（弱化块，按序）→ 文本段（markdown 气泡）→
//     工具调用卡（内联条目）→ 工具结果 → 继续文本段 → ……
//   文本增量按节拍重渲染；工具事件到达时当前文本段收尾（flushTextSegment），
//   后续文本开启新段 —— 不再按"思考/文本/工具"分区聚合。
//   thinking 弱化为独立信息块按序出现；context/status 类事件渲染为信息块。
// ============================================================================
import { $, el, esc, fmtNow, need } from '../utils/dom';
import { highlightCode } from '../utils/hljs';
import { marked } from 'marked';
import type { AssistantView } from './view';
import { S } from '../state';
import { railAdd, railReset, railSync } from './rail';
import { resetToolCards } from './toolcards';

marked.setOptions({ breaks: true, gfm: true });

const MsgsEl = need<HTMLElement>('#messages');

// ---- markdown ---------------------------------------------------------------
/** Render markdown to safe-enough HTML (same policy as the legacy UI). */
export function md(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return '<pre>' + esc(text) + '</pre>';
  }
}

// ---- scrolling ----------------------------------------------------------------
/** 粘性自动滚动：仅在用户接近底部时跟随；force 用于完成/新消息时。 */
export function autoscroll(force = false): void {
  const nearBottom = MsgsEl.scrollTop + MsgsEl.clientHeight >= MsgsEl.scrollHeight - 200;
  if (force || nearBottom) MsgsEl.scrollTop = MsgsEl.scrollHeight;
}

export function hideEmptyHint(): void {
  const hint = $('#emptyHint');
  if (hint) hint.classList.add('hidden');
}

/** Rebuild the empty state exactly as it shipped in index.html. */
export function renderEmptyHint(): void {
  MsgsEl.innerHTML = '';
  const hint = el('div', 'empty-hint empty-hint-fresh');
  hint.id = 'emptyHint';
  hint.appendChild(el('div', 'empty-mark', '◇'));
  hint.appendChild(el('div', 'empty-title', 'Celestea Studio'));
  hint.appendChild(el('div', 'empty-sub', '在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行'));
  MsgsEl.appendChild(hint);
}

/** 助手文本段是否已有内容（占位判定）。 */
export function assistantHasContent(view: AssistantView): boolean {
  return view.text.trim() !== '' || view.content.childElementCount > 0;
}

/** 直接移除空占位助手气泡（不渲染空块）。 */
export function removeAssistant(view: AssistantView): void {
  view.root.remove();
  S.assistant = null;
}

/** 清空消息流并重建空态（/api/clear 成功后调用；同时重置流式状态）。 */
export function resetMessages(): void {
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer);
    renderTimer = null;
  }
  S.assistant = null;
  S.turn = null;
  thinkSeg = null;
  lastTextCol = null;
  resetToolCards(); // 工具卡片（消息流级条目）复位
  railReset(); // 消息 rail 复位
  renderEmptyHint();
}

// ---- 流式正文渲染节流 ---------------------------------------------------------
const RENDER_INTERVAL = 60; // ms —— 重渲染节拍（兼顾流畅与 CPU）
let renderTimer: number | null = null;
let renderDeadline = 0;

function renderTextView(view: AssistantView): void {
  view.content.innerHTML = md(view.text);
  highlightCode(view.content);
  autoscroll();
  railSync();
}

function scheduleTextView(view: AssistantView): void {
  if (renderTimer !== null) return; // 已有一次节拍排队
  const wait = Math.max(0, renderDeadline + RENDER_INTERVAL - performance.now());
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderDeadline = performance.now();
    renderTextView(view);
  }, wait);
}

/** 立即冲刷（turn 结束 / done 事件 / 最终文本到来时调用）。 */
function flushTextView(view: AssistantView): void {
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer);
    renderTimer = null;
  }
  renderDeadline = performance.now();
  renderTextView(view);
}

/** 增量追加正文 delta（节拍渲染，不逐字重排）。 */
export function appendText(view: AssistantView, delta: string): void {
  view.text += delta || '';
  scheduleTextView(view);
}

/** Sync final assistant text from the done event. */
export function applyFinalText(view: AssistantView, text: string): void {
  if (typeof text !== 'string' || !text || view.text === text) return;
  view.text = text;
  flushTextView(view);
}

/** 冻结当前文本段：有内容则收尾为完整气泡，并解除当前段（工具事件/新段前调用）。 */
export function flushTextSegment(): void {
  if (S.assistant) {
    const a = S.assistant;
    S.assistant = null;
    if (assistantHasContent(a)) {
      a.bubble.classList.remove('streaming');
      a.bubble.classList.add('complete');
      flushTextView(a);
      autoscroll(true);
    } else {
      a.root.remove(); // 空占位不渲染
    }
  }
}

// ---- thinking（弱化独立段，按事件顺序出现，不再聚合进气泡） ----------------------

interface ThinkSeg {
  root: HTMLElement;   // .mcol 根（含折叠状态 class）
  head: HTMLElement;   // 标题行（可点折叠/展开）
  body: HTMLElement;   // 内容
  text: string;
}

let thinkSeg: ThinkSeg | null = null;
/**
 * 同轮最近文本段（含已被工具事件截断收尾的）：thinking 重排的目标锚点。
 * 工具截断场景下 S.assistant 已置空，但思考块仍须位于对应文本块上方。
 */
let lastTextCol: HTMLElement | null = null;

/** 轮次结束/新轮开始：清除思考段归属与文本段锚点（跨轮不跨移；DOM 保留）。 */
export function endTurn(): void {
  thinkSeg = null;
  lastTextCol = null;
}

/** Append a thinking delta（弱化块：左侧色条 + 浅色底 + 小字；独立成段）。
 * 第 22 轮重排规则收紧（任何到达顺序下成立）：
 *   思考块的目标位置 = 同轮最近文本块的正上方（紧贴）。目标 = 当前流式
 *   文本段（S.assistant.root）若存在，否则为 lastTextCol（同轮最近、含被
 *   tool 截断收尾的文本段）。若思考块当前位于目标之后（无论中间隔着
 *   工具卡/信息块等任何段落）→ insertBefore 局部前移到目标正上方；
 *   已在目标之前 → 不动。跨轮：endTurn() 清 thinkSeg/lastTextCol，绝不串位。
 */
export function appendThinking(delta: string): void {
  if (!thinkSeg) {
    hideEmptyHint();
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
    MsgsEl.appendChild(root);
    thinkSeg = { root, head: cap, body, text: '' };
    body.textContent = '思考中…'; // 流式思考占位态（弱化）
    // 点击标题行折叠/展开（第 23 轮：流式思考中不折叠）
    cap.addEventListener('click', () => {
      if (thinkSeg !== null && S.streaming) return; // 流式思考中不折叠
      root.classList.toggle('collapsed');
      foldMark.textContent = root.classList.contains('collapsed') ? '▸' : '▾';
    });
  }
  // 重排：目标 = 当前文本段 ?? 同轮最近文本段（含 tool 截断收尾的）
  const target = S.assistant?.root ?? lastTextCol;
  if (target && thinkSeg.root.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) {
    // 思考块位于目标之后（中间可隔工具卡等）→ 紧贴目标上方
    MsgsEl.insertBefore(thinkSeg.root, target);
  }
  thinkSeg.text += delta || '';
  thinkSeg.body.textContent = thinkSeg.text === '' ? '思考中…' : thinkSeg.text;
  autoscroll();
  railSync();
}

// ---- 信息块（context/status 类事件：注入、lagged、error 提示等） ------------------

/** 渲染一条可见信息块（按序出现在流中；样式与普通消息区分：左侧色条 + 浅色底）。 */
export function renderInfoBlock(text: string, cls?: 'err' | 'warn'): void {
  if (!text) return;
  hideEmptyHint();
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
  MsgsEl.appendChild(col);
  autoscroll(true);
}

// ---- message builders ----------------------------------------------------------

export function addUserMessage(text: string, container: HTMLElement = MsgsEl): void {
  hideEmptyHint();
  const col = el('div', 'mcol');
  const msg = el('div', 'msg user');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '你'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content');
  body.textContent = text;
  body.style.whiteSpace = 'pre-wrap';
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  container.appendChild(col);
  railAdd(col, 'user');
  railSync();
  autoscroll(true);
}

/** 获取当前文本段视图或创建新的流式文本气泡（连续流中的一段；container 用于离屏构建）。 */
export function ensureAssistant(container: HTMLElement = MsgsEl): AssistantView {
  if (S.assistant) return S.assistant;
  hideEmptyHint();
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
  container.appendChild(col);
  railAdd(col, 'assistant');
  railSync();

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
  lastTextCol = col; // 同轮最近文本段（thinking 重排锚点）
  S.assistant = view;
  autoscroll(true);
  return view;
}

/** 文本段收尾（turn 结束 / done 冲刷）。 */
export function finalizeAssistant(view: AssistantView): void {
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  flushTextView(view);
  autoscroll(true);
}
