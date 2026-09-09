// ============================================================================
// chat.ts — turn 生命周期 + SSE 接线（编排层）：
//   收到 SSE 事件 → 更新 state → 驱动 ui/messages · ui/toolcards · ui/statusbar。
//   发送/取消：读输入（ui/inputbar 回调）→ POST /api/turn | /api/cancel。
// ============================================================================
import { api } from './api';
import { SseClient } from './sse';
import type { Statusline } from './statusline';
import type {
  CompactPayload,
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
import { applyToolResult, getToolStep, pushToolCard, resetTurnStep } from './ui/toolcards';
import { clearInput, initInputBar, setBusy } from './ui/inputbar';
import {
  feedAssistantDelta,
  finalAssistantDedup,
  resolveActiveSession,
  restoreSessionHistory,
} from './ui/restore';
import {
  cancelStatusFlash,
  finishElapsedTimer,
  flashStatus,
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
  finishElapsedTimer(); // W263：保留本轮最终耗时（下一轮 start 时重置）
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
    // 第 23 轮：思考阶段绝不创建 assistant 气泡——只在首个 text delta
    // （onText 内 ensureAssistant）或工具卡需要时才创建；思考期间仅显示思考块。
    cancelStatusFlash(); // W259：/compact 的短暂提示让位给 turn 状态
    endTurn(); // 新轮开始：思考段归属重置（跨轮不跨移）
    if (S.streaming && S.assistant) {
      // 异常残留（理论上 finalizeTurn 已清）：有内容才收尾，空块直接移除
      if (assistantHasContent(S.assistant)) finalizeTurn('completed');
      else removeAssistant(S.assistant);
    }
    S.turn = p.turn ?? null;
    S.streaming = true;
    setBusy(true);
    setStatus('运行中…', 'busy');
    setStatusTurn(p.turn ?? null);
    resetTurnStep(); // W263：新一轮工具步数清零（每个 tool 事件 +1）
    setStatusStep(null);
    startElapsedTimer();
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
  sse.on('compact', (p) => {
    try {
      onCompact(p);
    } catch (err) {
      console.warn('SSE compact', err);
    }
  });
  sse.connect();
  return sse;
}

// ---- W259 /compact -------------------------------------------------------------

/** 压缩请求进行中（防连点）。 */
let compacting = false;
/** 本地刚压缩过的时间戳：吞掉同一动作回环回来的 compact SSE，避免重复重载。 */
let localCompactAt = 0;
const LOCAL_COMPACT_DEDUP_MS = 5_000;

/**
 * 收到 compact SSE（本客户端或其它客户端触发的压缩）：
 *   - turn 进行中不打断；
 *   - 只对当前活跃会话重载消息区，其它会话不打扰。
 */
function onCompact(p: CompactPayload): void {
  if (S.streaming) return;
  if (Date.now() - localCompactAt < LOCAL_COMPACT_DEDUP_MS) return; // 本地已处理
  void (async () => {
    const id = await resolveActiveSession();
    if (id === null) return;
    if (p.session && p.session !== id) return;
    await restoreSessionHistory(id);
    flashStatus(p.note || '上下文已压缩', 'ok');
  })();
}

/**
 * `/compact` 命令流程（W259）：
 *   - 仅当输入整体 trim 后精确等于 "/compact" 时触发——命令被消费（清空输入框），
 *     但绝不写入用户气泡、绝不 POST /api/turn，因此不产生普通 turn；
 *   - 三态提示（成功 / 无需压缩 / 错误）走状态栏短暂提示，不打断当前视图；
 *   - 成功后重载消息区（复用 restoreSessionHistory 的离屏双缓冲替换）。
 *   - 409（turn 进行中）/500（摘要失败）只提示错误，不改任何本地状态。
 */
async function runCompact(): Promise<void> {
  if (compacting) return;
  compacting = true;
  clearInput(); // 命令消费：输入框清空，但不当普通消息发送
  try {
    const id = await resolveActiveSession();
    if (id === null) {
      flashStatus('压缩失败：未找到活跃会话', 'err', 8000);
      return;
    }
    setStatus('压缩中…', 'busy');
    const r = await api.compactSession(id);
    if (r.compacted === false) {
      flashStatus(r.note || '历史不足，无需压缩', 'ok');
      return;
    }
    localCompactAt = Date.now();
    flashStatus(r.note || '已压缩：摘要轮 + 最近4轮', 'ok');
    await restoreSessionHistory(id); // 消息区 reload
  } catch (err) {
    flashStatus(
      '压缩失败：' + (err instanceof Error ? err.message : String(err)),
      'err',
      8_000,
    );
  } finally {
    compacting = false;
  }
}

// ---- send / cancel -------------------------------------------------------------

export function initChat(): void {
  initInputBar({
    send(text) {
      const t = text.trim();
      if (!t) return;
      // W259：/compact 是命令而非消息——走压缩流程，不进普通发送路径
      if (t === '/compact') {
        void runCompact();
        return;
      }
      if (S.streaming) return;
      addUserMessage(t);
      clearInput();
      S.streaming = true;
      S.turn = null;
      setBusy(true);
      setStatus('启动中…', 'busy');
      resetTurnStep(); // W263：发送即清零当前轮步数（SSE start 到达前也正确）
      setStatusStep(null);
      void api
        .turn(t)
        .then((r) => {
          if (S.turn === null && r.turn !== undefined) S.turn = r.turn;
          setStatusTurn(S.turn !== null ? S.turn : r.turn ?? 0);
          if (S.turn === null) startElapsedTimer();
          // 第 23 轮：不在此创建占位气泡——首个 text delta / 工具卡才创建
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
