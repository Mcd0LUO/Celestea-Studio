// ============================================================================
// ui/restore.ts — 启动/切换会话时恢复活跃会话历史：
//   GET /api/sessions/{id}/messages → 用与 live 相同的渲染管线渲染最近
//   N=200 条存量（更早的加折叠提示）→ 尾部加「以下为本次会话」分隔线 →
//   之后的 SSE 增量照旧。衔接去重：SSE 重放的助手文本若与已恢复尾部同内容
//   （前缀匹配）则吞掉，直到发散；done 全量一致时丢弃重复气泡。
//   404/超时/端点缺失 → 保持空视图 + 轻提示，绝不崩溃。
// ============================================================================
import { api } from '../api';
import { S } from '../state';
import { el } from '../utils/dom';
import type { HistoryMsg } from '../types';
import {
  addUserMessage,
  autoscroll,
  ensureAssistant,
  finalizeAssistant,
  renderEmptyHint,
} from './messages';
import { railReset, railSync } from './rail';
import { buildToolCard, setToolResult, type ToolCardRef } from './toolcards';

const MAX_RESTORE = 200;

// ---- 衔接去重状态 ------------------------------------------------------------

/** 已恢复尾部的最后一条（user/assistant；tool 不参与去重）。 */
let tail: HistoryMsg | null = null;

let guardActive = false;   // 正在对 live 助手增量做前缀匹配
let guardBuf = '';         // 已吞入的增量
let guardAll = false;      // 缓冲恰好等于完整 tail 内容（可能整体重放）

/** 重置去重状态（清空会话后调用）。 */
export function resetRestore(): void {
  tail = null;
  guardActive = false;
  guardBuf = '';
  guardAll = false;
}

/**
 * 处理一条 live 助手文本增量：若与已恢复尾部前缀匹配则吞掉（返回 null），
 * 发散后一次性吐出累积缓冲并解除守卫。
 */
export function feedAssistantDelta(delta: string): string | null {
  if (tail?.role !== 'assistant') {
    tail = null;
    return delta === '' ? null : delta;
  }
  if (!guardActive) {
    guardActive = true;
    guardBuf = '';
    guardAll = false;
  }
  guardBuf += delta;
  if (tail.content.startsWith(guardBuf)) {
    if (guardBuf === tail.content) guardAll = true;
    return null;
  }
  // 发散：吐出累积内容，退出守卫
  const out = guardBuf;
  guardActive = false;
  guardAll = false;
  tail = null;
  return out === '' ? null : out;
}

/**
 * done 事件钩子：若整条 live 助手消息是已恢复尾部的重放（无新增内容），
 * 返回 true 让调用方移除该重复气泡。
 */
export function finalAssistantDedup(text?: string): boolean {
  if (!guardActive) return false;
  guardActive = false;
  const drop =
    guardAll ||
    (typeof text === 'string' && text !== '' && tail?.role === 'assistant' && text === tail.content);
  guardAll = false;
  tail = null;
  return drop;
}

// ---- 渲染 ---------------------------------------------------------------------

// ---- 历史工具条目：解析并复用 live 工具卡片样式（第 8 轮） ----
// 契约 content 形如 "name(args)"（调用）或结果 JSON / "Error: …"（结果）。
// call 与随后的 result 配对成一张卡（折叠三行摘要：工具名/参数截断/结果截断，
// 可点击展开全文）；解析失败回退为普通文本行。
// 注：thinking / info 块是 SSE 专属、不落盘，恢复侧无需处理。

let histToolStep = 0;
let pendingTool: ToolCardRef | null = null;

/** 解析 "name(args)" 形态的工具调用条目。 */
function parseToolCall(content: string): { name: string; args: string } | null {
  const t = content.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\(([\s\S]*)\)$/.exec(t);
  if (!m) return null;
  return { name: m[1]!, args: m[2]! };
}

function appendFallbackToolLine(content: string, container: HTMLElement): void {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '工具'));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content restore-tool');
  body.textContent = content;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  container.appendChild(col);
}

function renderToolHistory(content: string, container: HTMLElement): void {
  const call = parseToolCall(content);
  if (call) {
    histToolStep += 1;
    const ref = buildToolCard({ step: histToolStep, name: call.name, argsText: call.args });
    container.appendChild(ref.col);
    pendingTool = ref; // 等待紧随其后的结果条目配对
    autoscroll(true);
    return;
  }
  if (pendingTool) {
    const failed = content.trim().startsWith('Error');
    setToolResult(pendingTool, content, failed);
    pendingTool = null;
    autoscroll(true);
    return;
  }
  appendFallbackToolLine(content, container); // 解析失败回退：普通文本行
}

function appendNote(text: string): void {
  const msgs = document.getElementById('messages');
  if (msgs && !msgs.querySelector('.restore-note')) {
    msgs.appendChild(el('div', 'restore-note', text));
  }
}

function renderOne(m: HistoryMsg, container: HTMLElement): void {
  const content = String(m.content);
  if (m.role === 'user') {
    addUserMessage(content, container);
    return;
  }
  if (m.role === 'assistant') {
    if (content.trim() === '') return; // 空内容不渲染空块
    // 与 live 相同的 marked 渲染管线（ensureAssistant → finalizeAssistant 冲刷）
    const a = ensureAssistant(container);
    a.text = content;
    finalizeAssistant(a);
    S.assistant = null;
    return;
  }
  renderToolHistory(content, container);
}

/**
 * 渲染指定会话历史（最近 200 条 + 折叠提示 + 「以下为本次会话」分隔线）。
 * 404/超时/端点缺失 → 空视图 + 轻提示，不崩溃。
 */
/**
 * 渲染指定会话历史（最近 200 条 + 折叠提示 + 「以下为本次会话」分隔线）。
 * 第 10 轮：离屏双缓冲——先在离屏容器完整构建，再一次性 replaceChildren，
 * 不出现「清空→空白→重建」帧；guard() 返回 false 时丢弃（竞态：旧请求
 * 结果晚到不得覆盖新会话）。404/超时/端点缺失 → 轻提示，不崩溃。
 */
export async function restoreSessionHistory(id: string, guard?: () => boolean): Promise<void> {
  let resp;
  try {
    resp = await api.messages(id);
  } catch (err) {
    // 404/超时/端点缺失：保持现有视图，仅轻提示
    if (!S.streaming) {
      appendNote('历史恢复暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）');
    }
    return;
  }
  if (guard && !guard()) return; // 竞态：期间已发起更新的切换，丢弃本次结果
  const all = resp.messages ?? [];
  if (S.streaming) return; // 已开跑：不打断实时流

  // 离屏构建（不挂载，浏览器不绘制中间态）
  railReset(); // 先清旧 rail 条目；离屏渲染注册的新条目在替换后重新 layout
  const off = document.createElement('div');
  if (all.length > MAX_RESTORE) {
    const fold = el('div', 'restore-fold', '更早的历史已折叠 · 仅显示最近 ' + MAX_RESTORE + ' 条');
    off.appendChild(fold);
  }
  const recent = all.length > MAX_RESTORE ? all.slice(all.length - MAX_RESTORE) : all;
  for (const m of recent) renderOne(m, off);
  if (pendingTool) {
    // 无配对结果的调用：历史视角标记为完成（无结果行）
    setToolResult(pendingTool, '（历史记录无结果）', false);
    pendingTool = null;
  }
  if (recent.length) {
    const sep = el('div', 'live-sep');
    sep.appendChild(el('span', null, '以下为本次会话'));
    sep.title = '上方为刷新前恢复的存量消息';
    off.appendChild(sep);
  }
  if (guard && !guard()) return;

  // 一次性替换（无空白帧）
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  msgs.replaceChildren(...off.childNodes);
  if (!recent.length) {
    // 空会话：重建空态视图
    renderEmptyHint();
  }
  railSync();
  autoscroll(true);
  tail = recent.length ? recent[recent.length - 1] ?? null : null;
}

/**
 * 解析当前活跃会话 id（W237）：
 *   1) GET /api/sessions 的 active 字段；2) GET /api/workspaces 的 active_session；
 *   3) 兜底：旧后端无 active 概念 → 若 cli-main 存在则用之；否则 null。
 */
export async function resolveActiveSession(): Promise<string | null> {
  try {
    const d = await api.sessions();
    const act = (d.sessions ?? []).find((s) => s.active === true);
    if (act?.id) return act.id;
  } catch {
    /* fall through */
  }
  try {
    const w = await api.workspaces();
    if (w.active_session) return w.active_session;
  } catch {
    /* fall through */
  }
  try {
    const d = await api.sessions();
    if ((d.sessions ?? []).some((s) => s.id === 'cli-main')) return 'cli-main';
  } catch {
    /* ignore */
  }
  return null;
}

/** 启动恢复：按当前活跃会话拉取历史（不再特设 cli-main）。 */
export async function restoreActiveHistory(): Promise<void> {
  const id = await resolveActiveSession();
  if (id === null) {
    if (!S.streaming) appendNote('未找到活跃会话 · 发送第一条消息后自动建立');
    return;
  }
  await restoreSessionHistory(id);
}

// ---- 会话切换（第 10 轮：无空白帧 + 竞态防护） ----

let switchSeq = 0;
let progressEl: HTMLElement | null = null;

function showSwitchProgress(): void {
  if (progressEl) return;
  progressEl = document.createElement('div');
  progressEl.className = 'switch-progress';
  progressEl.title = '正在加载会话历史…';
  document.body.appendChild(progressEl);
}

function hideSwitchProgress(): void {
  progressEl?.remove();
  progressEl = null;
}

/**
 * 激活会话后切换聊天区（第 10 轮）：
 *   - 不清空现有内容——历史在离屏构建完成后一次性替换（无空白帧）；
 *   - 加载期间仅显示顶部细进度条（轻量状态，不整页空白）；
 *   - seq 竞态防护：切换期间重复点击会发起更新的请求，旧请求结果
 *     （guard 不匹配）直接丢弃，不覆盖新会话。
 */
export function switchToSession(id: string): void {
  const seq = ++switchSeq;
  pendingTool = null;
  histToolStep = 0;
  S.assistant = null; // 旧流式视图随替换移除；新 turn 从新段开始
  S.turn = null;
  showSwitchProgress();
  void restoreSessionHistory(id, () => seq === switchSeq).finally(() => {
    if (seq === switchSeq) hideSwitchProgress();
  });
}

/** 会话切换是否进行中（供外部判断加载态）。 */
export function isSwitching(): boolean {
  return progressEl !== null;
}
