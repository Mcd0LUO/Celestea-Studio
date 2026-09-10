// ============================================================================
// chat.ts — turn 生命周期 + SSE 接线（编排层，W514 多会话版）：
//   收到 SSE 事件 → 按 session 路由到对应「会话视图容器」→ 更新该容器
//   （流/思考/工具卡）与（仅当它是当前聚焦容器时）statusline / 状态栏 / 输入栏。
//   发送：聚焦容器运行中 → 插话（POST /api/turn 带 session，注入该轮）；
//         空闲 → 现行开新轮路径；worker 容器 → 只读，不发。
//   旧后端（无 session 字段）→ 全部回落单会话行为（legacyOwner 记录归属）。
// ============================================================================
import { api } from './api';
import { SseClient } from './sse';
import { pickStatusFields, statusline } from './statusline';
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
  renderInterjectNote,
} from './ui/messages';
import { applyToolResult, getToolStep, pushToolCard, resetTurnStep } from './ui/toolcards';
import { clearInput, initInputBar, setBusy, setInputMode, setInputValue } from './ui/inputbar';
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
import {
  activePane,
  adoptLocalIfUnbound,
  ensurePane,
  isActivePane,
  LOCAL_ID,
  onBusyChange,
  onPaneChange,
  paneOf,
  setPaneStreaming,
  type SessionPane,
} from './ui/viewctx';
import { railActivate, railRebind } from './ui/rail';
import { updateSessionBar } from './ui/sessionbar';

const PHASE_LABELS: Record<string, string> = {
  completed: '完成',
  cancelled: '已取消',
  error: '出错',
};

// ---- 会话路由 ------------------------------------------------------------------

/**
 * 旧后端（SSE 无 session 字段）的流归属：本客户端最近一次发起 turn 的容器。
 * 有该记录时，未携带 session 的帧路由到它 —— 切到别的会话也能各自看到实时流；
 * 新后端每帧都带 session，此记录不参与路由。
 */
let legacyOwner: SessionPane | null = null;

function ctxFor(p: { session?: string | null }): SessionPane {
  const id = typeof p.session === 'string' && p.session !== '' ? p.session : null;
  if (id === null) return legacyOwner ?? activePane() ?? ensurePane(LOCAL_ID);
  const adopted = adoptLocalIfUnbound(id);
  if (adopted) return adopted;
  return paneOf(id) ?? ensurePane(id);
}

function sid(ctx: SessionPane): string | undefined {
  return ctx.id === LOCAL_ID ? undefined : ctx.id;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 后台容器的状态快照（不渲染，只缓存供切回时立即显示）。 */
function mergePaneStatus(ctx: SessionPane, p: StatusPayload): void {
  const flat = pickStatusFields({ ...(p.statusline ?? {}), ...p });
  if (Object.keys(flat).length > 0) ctx.status = { ...(ctx.status ?? {}), ...flat };
}

// ---- 聚焦容器 chrome 同步（statusline / 状态栏 / 输入栏 / 会话条） ------------------

/**
 * 输入栏模式真源（W514）：聚焦容器是否运行中 / 是否 worker 只读。
 * 发送按钮在运行中**不禁用**（走插话路径），只切文案与浅提示。
 */
function refreshInputMode(pane: SessionPane): void {
  setInputMode(pane.kind === 'worker' ? 'readonly' : pane.streaming ? 'interject' : 'idle');
}

function syncChrome(pane: SessionPane): void {
  S.t0 = pane.t0;
  S.turn = pane.turn;
  S.assistant = pane.assistant;
  const step = getToolStep(pane);
  setStatusTurn(pane.turn);
  setStatusStep(step > 0 ? String(step) : null);
  setBusy(pane.streaming);
  refreshInputMode(pane);
  statusline.setSession(pane.id);
  if (pane.streaming) {
    startElapsedTimer();
    setStatus(pane.phase || '运行中…', 'busy');
  } else {
    stopElapsedTimer();
    if (pane.phase) {
      setStatus(pane.phase, pane.phase === PHASE_LABELS['error'] || pane.phase === PHASE_LABELS['cancelled'] ? 'err' : 'ok');
    } else if (S.conn === 'online') {
      setStatus('就绪 · 在线', 'ok');
    } else if (S.conn === 'down') {
      setStatus('重连中…', 'err');
    }
  }
  updateSessionBar();
}

// ---- turn lifecycle（每个容器一份） ----------------------------------------------

function finalizeTurn(ctx: SessionPane, phase: string): void {
  endTurn(ctx); // 思考段归属随轮次结束清除（跨轮不跨移）
  const wasStreaming = ctx.streaming;
  setPaneStreaming(ctx, false);
  ctx.turn = null;
  ctx.phase = PHASE_LABELS[phase] || phase;
  const a = ctx.assistant;
  if (a) {
    if (assistantHasContent(a)) finalizeAssistant(ctx, a);
    else removeAssistant(ctx, a); // 空占位气泡（无正文/思考/工具内容）：不渲染空块
  }
  ctx.assistant = null;
  if (legacyOwner === ctx) legacyOwner = null;
  if (isActivePane(ctx)) {
    S.turn = null;
    S.assistant = null;
    setBusy(false);
    finishElapsedTimer(); // W263：保留本轮最终耗时（下一轮 start 时重置）
    setStatus(ctx.phase, phase === 'error' || phase === 'cancelled' ? 'err' : 'ok');
  }
  if (wasStreaming) autoscroll(ctx, true);
  updateSessionBar();
}

function onStatus(ctx: SessionPane, p: StatusPayload): void {
  if (p.phase === 'start') {
    // 思考阶段绝不创建 assistant 气泡——只在首个 text delta 或工具卡需要时才创建
    if (isActivePane(ctx)) cancelStatusFlash();
    endTurn(ctx); // 新轮开始：思考段归属重置
    if (ctx.streaming && ctx.assistant) {
      if (assistantHasContent(ctx.assistant)) finalizeTurn(ctx, 'completed');
      else removeAssistant(ctx, ctx.assistant);
    }
    ctx.turn = p.turn ?? null;
    ctx.t0 = Date.now();
    ctx.phase = '运行中…';
    setPaneStreaming(ctx, true);
    resetTurnStep(ctx); // W263：新一轮工具步数清零
    if (isActivePane(ctx)) {
      S.t0 = ctx.t0;
      setBusy(true);
      setStatus('运行中…', 'busy');
      setStatusTurn(ctx.turn);
      setStatusStep(null);
      startElapsedTimer();
    }
    updateSessionBar();
    return;
  }
  if (p.turn !== undefined && p.turn !== null && ctx.turn !== null && p.turn !== ctx.turn) {
    return;
  }
  if (p.phase === 'completed' || p.phase === 'cancelled' || p.phase === 'error') {
    finalizeTurn(ctx, p.phase || '');
    if (p.phase === 'error') {
      renderInfoBlock(ctx, '本轮出错：' + (p.error || '未知错误'), 'err');
    }
  }
  if (p.phase === 'lagged') {
    renderInfoBlock(ctx, '检测到慢客户端事件（lagged），已合并跳过', 'warn');
  }
  if (p.hint) {
    renderInfoBlock(ctx, String(p.hint), 'warn');
  }
}

function onText(ctx: SessionPane, p: TextPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== ctx.turn) return;
  if (ctx.streaming === false) setPaneStreaming(ctx, true);
  // 衔接去重：SSE 重放的增量若与已恢复尾部同内容则吞掉
  const delta = feedAssistantDelta(ctx, p.delta || '');
  if (delta === null) return;
  const a = ensureAssistant(ctx);
  appendText(ctx, a, delta);
  if (isActivePane(ctx)) setStatusTurn(ctx.turn);
}

function onThinking(ctx: SessionPane, p: ThinkingPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== ctx.turn) return;
  appendThinking(ctx, p.delta || ''); // 弱化思考段：按事件顺序独立渲染
}

function onTool(ctx: SessionPane, p: ToolPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  // 连续流：文本段先收尾，工具卡按事件顺序排在文本段之后
  flushTextSegment(ctx);
  pushToolCard(ctx, p); // 消息流级条目：按事件时间内联在消息流中
  if (isActivePane(ctx)) setStatusStep(getToolStep(ctx) > 0 ? String(getToolStep(ctx)) : null);
  autoscroll(ctx);
}

function onToolResult(ctx: SessionPane, p: ToolResultPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  applyToolResult(ctx, p);
  if (isActivePane(ctx)) setStatusStep(getToolStep(ctx) > 0 ? String(getToolStep(ctx)) : null);
  autoscroll(ctx);
}

function onDone(ctx: SessionPane, p: DonePayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  const a = ctx.assistant;
  if (!a) return;
  if (finalAssistantDedup(ctx, p.text)) {
    // 整条为已恢复尾部的重放：移除重复气泡
    a.root.remove();
    ctx.assistant = null;
    return;
  }
  if (typeof p.text === 'string') applyFinalText(ctx, a, p.text);
  // done = 一轮模型输出结束；在 status completed/cancelled/error 之前可能还有工具轮次
  autoscroll(ctx);
}

// ---- SSE wiring ---------------------------------------------------------------

export function connectSse(): SseClient {
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
      const ctx = ctxFor(p);
      if (isActivePane(ctx)) {
        statusline.fromSse(p);
        if (p.session && ctx.status) ctx.status = { ...ctx.status, ...pickStatusFields(p) };
      } else {
        mergePaneStatus(ctx, p);
      }
      onStatus(ctx, p);
    } catch (err) {
      console.warn('SSE status', err);
    }
  });
  sse.on('text', (p) => {
    try {
      onText(ctxFor(p), p);
    } catch (err) {
      console.warn('SSE text', err);
    }
  });
  sse.on('thinking', (p) => {
    try {
      onThinking(ctxFor(p), p);
    } catch (err) {
      console.warn('SSE thinking', err);
    }
  });
  sse.on('tool', (p) => {
    try {
      onTool(ctxFor(p), p);
    } catch (err) {
      console.warn('SSE tool', err);
    }
  });
  sse.on('tool_result', (p) => {
    try {
      onToolResult(ctxFor(p), p);
    } catch (err) {
      console.warn('SSE tool_result', err);
    }
  });
  sse.on('done', (p) => {
    try {
      statusline.onSseDone();
      onDone(ctxFor(p), p);
    } catch (err) {
      console.warn('SSE done', err);
    }
  });
  sse.on('context', (p) => {
    try {
      // 上下文注入/裁剪等系统事件 → 信息块按序出现在对应会话的流中
      renderInfoBlock(
        ctxFor(p),
        p.text || '上下文事件',
        p.cls === 'err' ? 'err' : p.cls === 'warn' ? 'warn' : undefined,
      );
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

/** 收到 compact SSE：只对对应容器重载消息区（运行中不打断），不打扰其它会话。 */
function onCompact(p: CompactPayload): void {
  if (Date.now() - localCompactAt < LOCAL_COMPACT_DEDUP_MS) return; // 本地已处理
  const id = typeof p.session === 'string' && p.session !== '' ? p.session : null;
  const ctx = id ? (paneOf(id) ?? null) : activePane();
  if (!ctx || ctx.streaming) return;
  void (async () => {
    await restoreSessionHistory(ctx);
    if (isActivePane(ctx)) flashStatus(p.note || '上下文已压缩', 'ok');
  })();
}

/**
 * `/compact` 命令流程（W259）：仅当输入整体 trim 后精确等于 "/compact" 时触发，
 * 命令被消费（清空输入框），绝不写入用户气泡、绝不 POST /api/turn。
 */
async function runCompact(ctx: SessionPane): Promise<void> {
  if (compacting) return;
  compacting = true;
  clearInput(); // 命令消费：输入框清空，但不当普通消息发送
  ctx.draft = '';
  try {
    let id = sid(ctx);
    if (id === undefined) {
      const resolved = await resolveActiveSession();
      if (resolved === null) {
        flashStatus('压缩失败：未找到活跃会话', 'err', 8000);
        return;
      }
      id = resolved;
    }
    setStatus('压缩中…', 'busy');
    const r = await api.compactSession(id);
    if (r.compacted === false) {
      flashStatus(r.note || '历史不足，无需压缩', 'ok');
      return;
    }
    localCompactAt = Date.now();
    flashStatus(r.note || '已压缩：摘要轮 + 最近4轮', 'ok');
    await restoreSessionHistory(ctx); // 消息区 reload
  } catch (err) {
    flashStatus('压缩失败：' + msgOf(err), 'err', 8_000);
  } finally {
    compacting = false;
  }
}

// ---- send / cancel -------------------------------------------------------------

/**
 * 取消当前聚焦容器的轮次（单一取消入口）：#btnCancel 与 statusline 的 #slStop 共用。
 * 失败只提示错误，本地状态交由 SSE 的 status:cancelled 收尾（finalizeTurn）。
 */
export function requestCancel(): void {
  const ctx = activePane();
  if (!ctx || !ctx.streaming) return;
  setStatus('取消中…', 'busy');
  void api.cancel(sid(ctx)).catch((err: unknown) => {
    setStatus('取消失败：' + msgOf(err), 'err');
  });
}

/** 发送入口：命令 → 只读拦截 → 运行中插话 → 空闲开新轮。 */
function dispatchSend(text: string): void {
  const t = text.trim();
  const ctx = activePane();
  if (!ctx || t === '') return;
  if (t === '/compact') {
    // W259：/compact 是命令而非消息——走压缩流程，不进普通发送路径
    void runCompact(ctx);
    return;
  }
  if (ctx.kind === 'worker') {
    flashStatus('Worker 会话为只读视图，未发送', 'err', 5_000);
    return;
  }
  ctx.draft = '';
  if (ctx.streaming) {
    void interject(ctx, t);
    return;
  }
  startTurn(ctx, t);
}

/** 空闲路径：开新轮（现行行为，带 session 以便后端定位目标会话）。 */
function startTurn(ctx: SessionPane, t: string): void {
  addUserMessage(ctx, t);
  clearInput();
  legacyOwner = ctx;
  setPaneStreaming(ctx, true);
  ctx.turn = null;
  ctx.t0 = Date.now();
  ctx.phase = '启动中…';
  resetTurnStep(ctx); // W263：发送即清零当前轮步数（SSE start 到达前也正确）
  if (isActivePane(ctx)) {
    S.t0 = ctx.t0;
    setBusy(true);
    setStatus('启动中…', 'busy');
    setStatusStep(null);
    startElapsedTimer();
  }
  updateSessionBar();
  void api
    .turn(t, sid(ctx))
    .then((r) => {
      if (r.session) adoptLocalIfUnbound(r.session);
      if (ctx.turn === null && r.turn !== undefined) ctx.turn = r.turn;
      ctx.phase = '运行中…';
      if (isActivePane(ctx)) {
        setStatusTurn(ctx.turn !== null ? ctx.turn : (r.turn ?? 0));
        setStatus('运行中…', 'busy');
      }
    })
    .catch((err: unknown) => {
      // 403/409/…：直接展示；容器回到空闲态并保留已渲染的用户消息
      setPaneStreaming(ctx, false);
      ctx.phase = '发送失败';
      if (legacyOwner === ctx) legacyOwner = null;
      if (isActivePane(ctx)) {
        setBusy(false);
        stopElapsedTimer();
        setStatus('发送失败：' + msgOf(err), 'err');
      }
      renderInfoBlock(ctx, '发送失败：' + msgOf(err), 'err');
      updateSessionBar();
    });
}

/**
 * 运行中插话（W514 契约 4）：POST /api/turn {input, session} 在目标会话运行中
 * = 注入该轮（不新开轮）。
 *   1) 先按「插话」样式渲染该条输入 + 轻提示「已插话 · 等待送达…」；
 *   2) 成功（injected=true）→ 提示改「已插话 · 将在下一步送达」；
 *   3) 后端把它当成新轮（injected=false，旧后端在本地 streaming 过期时）→ 按新一轮记账；
 *   4) 失败（409/404/405：契约未就绪的旧后端 / 目标会话已结束）→ 撤销乐观渲染、
 *      把文本还原回输入框（不丢字），只在状态栏给出错误 —— 与现状行为一致。
 */
async function interject(ctx: SessionPane, t: string): Promise<void> {
  const col = addUserMessage(ctx, t, { interject: true });
  clearInput();
  ctx.draft = '';
  const note = renderInterjectNote(ctx, '已插话 · 等待送达…', undefined, col);
  legacyOwner = ctx;
  if (isActivePane(ctx)) flashStatus('已插话，将在下一步送达', 'busy', 4_000);
  try {
    const r = await api.turn(t, sid(ctx));
    if (r.injected === false) {
      // 后端按新一轮接收（本地运行态已过期）：按开新轮记账
      ctx.turn = r.turn ?? ctx.turn;
      setPaneStreaming(ctx, true);
      ctx.phase = '运行中…';
      note.textContent = '已作为新一轮发送';
      note.className = 'interject-note ok';
      updateSessionBar();
      return;
    }
    note.textContent = '已插话 · 将在下一步送达';
    note.className = 'interject-note ok';
  } catch (err: unknown) {
    col.remove();
    note.parentElement?.remove();
    ctx.interjectNote = null;
    restoreDraft(ctx, t);
    const hint =
      '插话未送达（' + msgOf(err) + '）：已将内容还原到输入框';
    if (isActivePane(ctx)) {
      setStatus(hint, 'err');
      window.setTimeout(() => flashStatus(hint, 'err', 6_000), 0);
    }
    renderInfoBlock(ctx, hint, 'warn');
  }
}

/** 插话失败时把文本还原回输入框（仅当用户没在输入框里新打字）。 */
function restoreDraft(ctx: SessionPane, text: string): void {
  ctx.draft = text;
  if (!isActivePane(ctx)) return;
  const el = document.querySelector<HTMLTextAreaElement>('#input');
  if (el && el.value.trim() === '') setInputValue(text);
}

// ---- 装配 ----------------------------------------------------------------------

export function initChat(): void {
  initInputBar({
    send(text) {
      dispatchSend(text);
    },
    // W302：取消回调改为模块级 requestCancel，与 #slStop 共用同一入口
    cancel: requestCancel,
  });

  // 会话切换：rail 换轨 + chrome（statusline/状态栏/输入栏/会话条）同步。
  // 只做 class/文本/节点搬家 —— 背景视图零重渲染（铁律 5）。
  onPaneChange((pane) => {
    railActivate(pane);
    railRebind(pane);
    syncChrome(pane);
  });

  // 任一会话运行态变化 → 会话条 + 侧栏运行态点（订阅方各自局部更新）；
  // 聚焦容器的运行态变化同时刷新输入栏模式（运行中 → 插话态，不再禁用发送）。
  onBusyChange((id) => {
    updateSessionBar();
    const pane = activePane();
    if (pane && (pane.id === id || (pane.id === LOCAL_ID && id === LOCAL_ID))) {
      refreshInputMode(pane);
      setBusy(pane.streaming);
    }
  });
}
