// ============================================================================
// ui/messages.ts — 消息流（单一职责）：
//   用户/助手气泡 · thinking（默认收起 + 时长徽标）· 流式 markdown 增量渲染
// 流式渲染：delta 增量累积 + 固定节拍重渲染（时间节流），完成时冲刷一次，
// 避免每个 delta 全量重解析造成的闪烁/跳变。
// ============================================================================
import { $, el, esc, fmtNow, need } from '../utils/dom';
import { highlightCode } from '../utils/hljs';
import { marked } from 'marked';
import type { AssistantView } from './view';
import { S } from '../state';
import { railAdd, railReset, railSync } from './rail';
import { resetToolCards } from './toolcards'; // 灵动选择条 v3（W238 重做）

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

/** 助手气泡是否已有任何内容（正文/思考/工具卡）——占位判定。 */
export function assistantHasContent(view: AssistantView): boolean {
  return view.text.trim() !== '' || view.thinkText.trim() !== '' || view.content.childElementCount > 0;
}

/** 直接移除空占位助手气泡（不渲染空块）。 */
export function removeAssistant(view: AssistantView): void {
  view.root.remove();
  S.assistant = null;
}

/** 清空消息流并重建空态（/api/clear 成功后调用；同时重置流式/思考状态）。 */
export function resetMessages(): void {
  stopThinkTimer();
  thinkStart = 0;
  thinkLast = 0;
  thinkView = null;
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer);
    renderTimer = null;
  }
  S.assistant = null;
  S.turn = null;
  resetToolCards(); // 工具卡片（消息流级条目）复位
  railReset(); // 清空选择条 v3 条目
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
  railSync(); // 流式高度变化 → 选择条计数/重排同步
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

// ---- thinking（默认收起 · 时长） ------------------------------------------------
const THINK_IDLE_MS = 5000; // 超过 5s 无增量 → 视为思考结束，冻结时长
let thinkStart = 0;
let thinkLast = 0;
let thinkTimer: number | null = null;
let thinkView: AssistantView | null = null;

function fmtThinkDur(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  if (t < 60) return t + 's';
  const m = Math.floor(t / 60);
  const s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function renderThinkTime(view: AssistantView): void {
  if (thinkStart === 0) return;
  view.thinkTime.textContent = fmtThinkDur(thinkLast - thinkStart);
}

function tickThink(): void {
  const now = Date.now();
  if (now - thinkLast > THINK_IDLE_MS) {
    stopThinkTimer(); // 冻结
    return;
  }
  if (thinkView) renderThinkTime(thinkView);
}

function stopThinkTimer(): void {
  if (thinkTimer !== null) {
    window.clearInterval(thinkTimer);
    thinkTimer = null;
  }
  if (thinkView) renderThinkTime(thinkView);
}

/** Append a thinking delta（块保持收起；首次出现时显示并启动时长计时）。 */
export function appendThinking(view: AssistantView, delta: string): void {
  view.thinkText += delta || '';
  view.think.classList.remove('idle');
  view.think.classList.add('summarizing');
  if (thinkTimer === null) {
    // 新一轮思考会话：重置起点（上一轮已在 finalize 后停止）
    thinkStart = Date.now();
    thinkLast = thinkStart;
    thinkView = view;
    thinkTimer = window.setInterval(tickThink, 500);
    view.thinkTime.textContent = '';
  }
  thinkLast = Date.now();
  renderThinkTime(view);
  view.thinkBody.textContent = view.thinkText;
  autoscroll();
  railSync();
}

/** Transition the bubble out of streaming state（冲刷正文 + 冻结思考时长）。 */
export function finalizeAssistant(view: AssistantView): void {
  stopThinkTimer();
  thinkView = null;
  view.think.classList.remove('summarizing');
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  flushTextView(view); // 最终渲染，丢弃未冲刷的 delta
  autoscroll(true);
}

// ---- message builders ----------------------------------------------------------

export function addUserMessage(text: string): void {
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
  MsgsEl.appendChild(col);
  railAdd(col, 'user'); // 选择条 v3：用户消息 → 一根长条
  railSync();
  autoscroll(true);
}

/** Get the active assistant view or create a fresh streaming bubble. */
export function ensureAssistant(): AssistantView {
  if (S.assistant) return S.assistant;
  hideEmptyHint();
  const col = el('div', 'mcol');
  const msg = el('div', 'msg assistant');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', 'Studio'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble streaming');

  // thinking：默认收起 + 时长徽标；无思考增量时整块隐藏（idle）
  const think = document.createElement('details');
  think.className = 'thinking idle';
  const thinkSummary = document.createElement('summary');
  thinkSummary.appendChild(el('span', 'think-dot'));
  thinkSummary.appendChild(el('span', 'think-label', '思考过程'));
  const thinkTime = el('span', 'think-time');
  thinkSummary.appendChild(thinkTime);
  think.appendChild(thinkSummary);
  const thinkBody = el('div', 'thinking-body');
  think.appendChild(thinkBody);
  bubble.appendChild(think);

  const cards = el('div', 'toolcards');
  bubble.appendChild(cards);

  const content = el('div', 'content');
  bubble.appendChild(content);

  msg.appendChild(bubble);
  col.appendChild(msg);
  MsgsEl.appendChild(col);
  railAdd(col, 'assistant'); // 选择条 v3：助手回复 → 一根长条
  railSync();

  const view: AssistantView = {
    root: msg,
    bubble,
    think,
    thinkBody,
    thinkTime,
    cards,
    content,
    text: '',
    thinkText: '',
    ops: new Map(),
    steps: 0,
  };
  S.assistant = view;
  autoscroll(true);
  return view;
}
