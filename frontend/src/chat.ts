// ============================================================================
// 会话主循环：发送/取消、SSE 事件归并（turn 生命周期）、底部状态栏。
// ============================================================================
import { api } from './api';
import { SseClient } from './sse';
import type { Statusline } from './statusline';
import type {
  DonePayload,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from './types';
import { S } from './state';
import { el, fmtTime, need } from './utils/dom';
import {
  addUserMessage,
  applyFinalText,
  appendThinking,
  autoscroll,
  ensureAssistant,
  finalizeAssistant,
  renderAssistantText,
} from './ui/messages';
import { applyToolResult, pushToolCard } from './ui/toolcards';

// ---- bottom statusbar ------------------------------------------------------------

const StatusText = need<HTMLElement>('#statusText');
const StatusDot = need<HTMLElement>('#statusDot');
const StatusTurn = need<HTMLElement>('#statusTurn');
const StatusStep = need<HTMLElement>('#statusStep');
const StatusTime = need<HTMLElement>('#statusTime');

export function setStatus(text: string, cls?: string): void {
  StatusText.textContent = text;
  StatusDot.className = 'dot' + (cls ? ' ' + cls : '');
}

export function setStatusTurn(n: number | null): void {
  StatusTurn.textContent = typeof n === 'number' && n >= 1 ? 'turn ' + n : 'turn —';
}

export function setStatusStep(n: number | string | null): void {
  StatusStep.textContent = 'step ' + (n && String(n) !== '' ? String(n) : '—');
}

function tickTimer(): void {
  if (!S.streaming) return;
  StatusTime.textContent = fmtTime((Date.now() - S.t0) / 1000);
}

function startTimer(): void {
  S.t0 = Date.now();
  stopTimer();
  S.msgTimer = window.setInterval(tickTimer, 500);
  tickTimer();
}

function stopTimer(): void {
  if (S.msgTimer !== null) {
    window.clearInterval(S.msgTimer);
    S.msgTimer = null;
  }
}

// ---- turn lifecycle ----------------------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  completed: '完成',
  cancelled: '已取消',
  error: '出错',
};

function finalizeTurn(phase: string): void {
  const wasStreaming = S.streaming;
  S.streaming = false;
  S.turn = null;
  const sendBtn = need<HTMLButtonElement>('#btnSend');
  const cancelBtn = need<HTMLButtonElement>('#btnCancel');
  sendBtn.disabled = false;
  cancelBtn.classList.add('hidden');
  stopTimer();
  setStatus(
    PHASE_LABELS[phase] || phase,
    phase === 'error' || phase === 'cancelled' ? 'err' : 'ok',
  );
  if (S.assistant) {
    finalizeAssistant(S.assistant);
  }
  S.assistant = null;
  if (wasStreaming) autoscroll(true);
}

function onStatus(p: StatusPayload): void {
  if (p.phase === 'start') {
    // 新 turn：结束上一个未完成的会话视图
    if (S.streaming && S.assistant) finalizeTurn('completed');
    S.turn = p.turn ?? null;
    S.streaming = true;
    need<HTMLButtonElement>('#btnSend').disabled = true;
    need<HTMLButtonElement>('#btnCancel').classList.remove('hidden');
    setStatus('运行中…', 'busy');
    setStatusTurn(p.turn ?? null);
    setStatusStep(null);
    startTimer();
    ensureAssistant();
    return;
  }
  if (
    p.turn !== undefined &&
    p.turn !== null &&
    S.turn !== null &&
    p.turn !== S.turn
  ) {
    return;
  }
  if (p.phase === 'completed' || p.phase === 'cancelled' || p.phase === 'error') {
    const a = S.assistant;
    finalizeTurn(p.phase || '');
    if (p.phase === 'error' && a && p.error) {
      a.bubble.appendChild(el('div', 'err-inline', String(p.error)));
    }
  }
  // 'lagged'：慢客户端，静默容忍
}

function onText(p: TextPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== S.turn) return;
  if (S.streaming === false) {
    S.streaming = true;
    need<HTMLButtonElement>('#btnSend').disabled = true;
    need<HTMLButtonElement>('#btnCancel').classList.remove('hidden');
  }
  const a = ensureAssistant();
  a.text += p.delta || '';
  renderAssistantText(a);
  autoscroll();
}

function onThinking(p: ThinkingPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== S.turn) return;
  const a = ensureAssistant();
  appendThinking(a, p.delta || '');
  autoscroll();
}

function onTool(p: ToolPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  const a = ensureAssistant();
  pushToolCard(a, p);
  setStatusStep(a.steps > 0 ? String(a.steps) : null);
  autoscroll();
}

function onToolResult(p: ToolResultPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  if (!S.assistant) return;
  applyToolResult(S.assistant, p);
  setStatusStep(S.assistant.steps > 0 ? String(S.assistant.steps) : null);
  autoscroll();
}

function onDone(p: DonePayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  const a = S.assistant;
  if (!a) return;
  if (typeof p.text === 'string') applyFinalText(a, p.text);
  // done = 一轮模型输出结束；在 status completed/cancelled/error 之前可能还有工具轮次
  autoscroll();
}

// ---- SSE wiring ---------------------------------------------------------------

export function connectSse(statusline: Statusline): SseClient {
  const sse = new SseClient();
  sse.onConn((state) => {
    S.conn = state;
    if (state === 'online') {
      setStatus(S.streaming ? '运行中…' : '就绪 · 在线', S.streaming ? 'busy' : 'ok');
    } else if (state === 'down') {
      setStatus('重连中…', 'err');
    }
  });
  sse.on('status', (p) => {
    try {
      statusline.fromSse(p);
      onStatus(p);
    } catch (err) {
      console.warn('SSE status', err);
    }
  });
  sse.on('text', (p) => {
    try {
      onText(p);
    } catch (err) {
      console.warn('SSE text', err);
    }
  });
  sse.on('thinking', (p) => {
    try {
      onThinking(p);
    } catch (err) {
      console.warn('SSE thinking', err);
    }
  });
  sse.on('tool', (p) => {
    try {
      onTool(p);
    } catch (err) {
      console.warn('SSE tool', err);
    }
  });
  sse.on('tool_result', (p) => {
    try {
      onToolResult(p);
    } catch (err) {
      console.warn('SSE tool_result', err);
    }
  });
  sse.on('done', (p) => {
    try {
      onDone(p);
    } catch (err) {
      console.warn('SSE done', err);
    }
  });
  sse.connect();
  return sse;
}

// ---- send / cancel -------------------------------------------------------------

function autoGrowInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 240) + 'px';
}

export function initChatInput(): void {
  const input = need<HTMLTextAreaElement>('#input');
  const sendBtn = need<HTMLButtonElement>('#btnSend');
  const cancelBtn = need<HTMLButtonElement>('#btnCancel');

  function send(): void {
    const text = input.value.trim();
    if (!text || S.streaming) return;
    addUserMessage(text);
    input.value = '';
    autoGrowInput(input);
    S.streaming = true;
    S.turn = null;
    sendBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    setStatus('启动中…', 'busy');
    setStatusStep(null);
    void api
      .turn(text)
      .then((r) => {
        if (S.turn === null && r.turn !== undefined) S.turn = r.turn;
        setStatusTurn(S.turn !== null ? S.turn : r.turn ?? 0);
        if (S.turn === null) startTimer();
        ensureAssistant();
        setStatus('运行中…', 'busy');
      })
      .catch((err: unknown) => {
        // 403/409/… 直接展示
        S.streaming = false;
        sendBtn.disabled = false;
        cancelBtn.classList.add('hidden');
        stopTimer();
        setStatus('发送失败：' + (err instanceof Error ? err.message : String(err)), 'err');
      });
  }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => {
    if (!S.streaming) return;
    setStatus('取消中…', 'busy');
    void api.cancel().catch((err: unknown) => {
      setStatus('取消失败：' + (err instanceof Error ? err.message : String(err)), 'err');
    });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => autoGrowInput(input));
  window.setTimeout(() => autoGrowInput(input), 0);
}
