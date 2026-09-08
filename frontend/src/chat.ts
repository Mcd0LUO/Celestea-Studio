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
import {
  addUserMessage,
  appendText,
  appendThinking,
  applyFinalText,
  assistantHasContent,
  autoscroll,
  endTurn,
  ensureAssistant,
  finalizeAssistant,
  flushTextSegment,
  removeAssistant,
  renderInfoBlock,
} from './ui/messages';
import { applyToolResult, getToolStep, pushToolCard } from './ui/toolcards';
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
  endTurn(); // 思考段归属随轮次结束清除（跨轮不跨移）
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
    if (assistantHasContent(S.assistant)) {
      finalizeAssistant(S.assistant);
    } else {
      // 空占位气泡（无正文/思考/工具内容）：不渲染空块
      removeAssistant(S.assistant);
    }
  }
  S.assistant = null;
  if (wasStreaming) autoscroll(true);
}

function onStatus(p: StatusPayload): void {
  if (p.phase === 'start') {
    // 新 turn：若上一视图已有内容则收尾；空占位气泡直接复用，避免双块
    endTurn(); // 新轮开始：思考段归属重置（跨轮不跨移）
    if (S.streaming && S.assistant) {
      if (assistantHasContent(S.assistant)) finalizeTurn('completed');
      else removeAssistant(S.assistant); // 丢弃空占位（含 DOM），本轮重建唯一块
    }
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
    finalizeTurn(p.phase || '');
    if (p.phase === 'error') {
      // 出错提示作为信息块按序出现在流中
      renderInfoBlock('本轮出错：' + (p.error || '未知错误'), 'err');
    }
  }
  if (p.phase === 'lagged') {
    // 慢客户端：可见信息块（不再静默）
    renderInfoBlock('检测到慢客户端事件（lagged），已合并跳过', 'warn');
  }
  if (p.hint) {
    renderInfoBlock(String(p.hint), 'warn');
  }
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
  appendThinking(p.delta || ''); // 弱化思考段：按事件顺序独立渲染
}

function onTool(p: ToolPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  // 连续流：文本段先收尾，工具卡按事件顺序排在文本段之后
  flushTextSegment();
  pushToolCard(p); // 消息流级条目：按事件时间内联在消息流中
  setStatusStep(getToolStep() > 0 ? String(getToolStep()) : null);
  autoscroll();
}

function onToolResult(p: ToolResultPayload): void {
  if (S.turn === null) S.turn = p.turn ?? null;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  applyToolResult(p);
  setStatusStep(getToolStep() > 0 ? String(getToolStep()) : null);
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
  sse.on('context', (p) => {
    try {
      // 上下文注入/裁剪等系统事件 → 信息块按序出现在流中
      renderInfoBlock(p.text || '上下文事件', p.cls === 'err' ? 'err' : p.cls === 'warn' ? 'warn' : undefined);
    } catch (err) {
      console.warn('SSE context', err);
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
