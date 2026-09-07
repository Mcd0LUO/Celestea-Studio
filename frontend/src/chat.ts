// ============================================================================
// chat.ts — turn 生命周期 + SSE 接线（编排层）：
//   收到 SSE 事件 → 更新 state → 驱动 ui/messages · ui/toolcards · ui/statusbar。
//   发送/取消：读输入（ui/inputbar 回调）→ POST /api/turn | /api/cancel。
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
import { el } from './utils/dom';
import {
  addUserMessage,
  appendText,
  appendThinking,
  applyFinalText,
  autoscroll,
  ensureAssistant,
  finalizeAssistant,
} from './ui/messages';
import { applyToolResult, pushToolCard } from './ui/toolcards';
import { clearInput, initInputBar, setBusy } from './ui/inputbar';
import { feedAssistantDelta, finalAssistantDedup } from './ui/restore';
import {
  setStatus,
  setStatusStep,
  setStatusTurn,
  startElapsedTimer,
  stopElapsedTimer,
} from './ui/statusbar';

const PHASE_LABELS: Record<string, string> = {
  completed: '完成',
  cancelled: '已取消',
  error: '出错',
};

// ---- turn lifecycle ----------------------------------------------------------------

function finalizeTurn(phase: string): void {
  const wasStreaming = S.streaming;
  S.streaming = false;
  S.turn = null;
  setBusy(false);
  stopElapsedTimer();
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
    setBusy(true);
    setStatus('运行中…', 'busy');
    setStatusTurn(p.turn ?? null);
    setStatusStep(null);
    startElapsedTimer();
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
    setBusy(true);
  }
  // 衔接去重：SSE 重放的增量若与已恢复尾部同内容则吞掉
  const delta = feedAssistantDelta(p.delta || '');
  if (delta === null) return;
  const a = ensureAssistant();
  appendText(a, delta);
}

function onThinking(p: ThinkingPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== S.turn) return;
  const a = ensureAssistant();
  appendThinking(a, p.delta || '');
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
  if (finalAssistantDedup(p.text)) {
    // 整条为已恢复尾部的重放：移除重复气泡
    a.root.remove();
    S.assistant = null;
    return;
  }
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
      statusline.onSseDone();
      onDone(p);
    } catch (err) {
      console.warn('SSE done', err);
    }
  });
  sse.connect();
  return sse;
}

// ---- send / cancel -------------------------------------------------------------

export function initChat(): void {
  initInputBar({
    send(text) {
      const t = text.trim();
      if (!t || S.streaming) return;
      addUserMessage(t);
      clearInput();
      S.streaming = true;
      S.turn = null;
      setBusy(true);
      setStatus('启动中…', 'busy');
      setStatusStep(null);
      void api
        .turn(t)
        .then((r) => {
          if (S.turn === null && r.turn !== undefined) S.turn = r.turn;
          setStatusTurn(S.turn !== null ? S.turn : r.turn ?? 0);
          if (S.turn === null) startElapsedTimer();
          ensureAssistant();
          setStatus('运行中…', 'busy');
        })
        .catch((err: unknown) => {
          // 403/409/… 直接展示
          S.streaming = false;
          setBusy(false);
          stopElapsedTimer();
          setStatus('发送失败：' + (err instanceof Error ? err.message : String(err)), 'err');
        });
    },
    cancel() {
      if (!S.streaming) return;
      setStatus('取消中…', 'busy');
      void api.cancel().catch((err: unknown) => {
        setStatus('取消失败：' + (err instanceof Error ? err.message : String(err)), 'err');
      });
    },
  });
}
