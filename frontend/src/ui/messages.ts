// ============================================================================
// 聊天消息流：用户消息 / 助手气泡（thinking 折叠 + markdown 正文 + 光标）
// ============================================================================
import { $, el, esc, fmtNow, need } from '../utils/dom';
import { highlightCode } from '../utils/hljs';
import { marked } from 'marked';
import type { AssistantView } from '../state';
import { S } from '../state';

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

export function autoscroll(force = false): void {
  const nearBottom = MsgsEl.scrollTop + MsgsEl.clientHeight >= MsgsEl.scrollHeight - 160;
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

/** 清空消息流并重建空态（/api/clear 成功后调用）。 */
export function resetMessages(): void {
  S.assistant = null;
  S.turn = null;
  renderEmptyHint();
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

  const think = document.createElement('details');
  think.className = 'thinking';
  think.innerHTML =
    '<summary><span class="think-dot"></span><span>思考过程</span></summary><div class="thinking-body"></div>';
  const thinkBody = need<HTMLElement>('.thinking-body', think);
  bubble.appendChild(think);

  const cards = el('div', 'toolcards');
  bubble.appendChild(cards);

  const content = el('div', 'content');
  bubble.appendChild(content);

  msg.appendChild(bubble);
  col.appendChild(msg);
  MsgsEl.appendChild(col);

  const view: AssistantView = {
    root: msg,
    bubble,
    think,
    thinkBody,
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

/** Re-render the streaming markdown body (drops caret when empty). */
export function renderAssistantText(view: AssistantView): void {
  view.content.innerHTML = md(view.text);
  highlightCode(view.content);
}

/** Append a thinking delta (auto-opens once). */
export function appendThinking(view: AssistantView, delta: string): void {
  view.thinkText += delta;
  if (!view.think.classList.contains('summarizing')) view.think.classList.add('summarizing');
  if (!view.think.open) view.think.open = true;
  view.thinkBody.textContent = view.thinkText;
  autoscroll();
}

/** Sync final assistant text from the done event. */
export function applyFinalText(view: AssistantView, text: string): void {
  if (typeof text !== 'string' || !text || view.text === text) return;
  view.text = text;
  renderAssistantText(view);
}

/** Transition the bubble out of streaming state. */
export function finalizeAssistant(view: AssistantView): void {
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  renderAssistantText(view); // drop caret
  autoscroll(true);
}
