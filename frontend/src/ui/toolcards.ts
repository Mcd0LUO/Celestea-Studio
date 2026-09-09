// ============================================================================
// ui/toolcards.ts — 工具调用卡片（W239 任务 3+4 重写）：
//   任务4：工具事件按发生时间与 user/assistant 消息交错内联 —— 卡片不再
//          集中在助手气泡顶部区块，而是作为消息流级条目（.mcol.msg.tool）
//          按事件顺序插入 #messages（用户消息 → 工具调用+结果 → 助手回复）。
//   任务3：折叠态即显示粗略内容 —— summary 两行：
//          第1行 step · 工具名 · 状态；第2行 参数一行摘要（截断 ~60 字）；
//          结果到达后追加第3行 结果一行摘要（value 首行截断 ~60 字）。
//          展开（open）才见参数/结果全文（沿用 .tool-details 体系）。
// ============================================================================
import { el } from '../utils/dom';
import { autoscroll } from './messages';
import type { ToolPayload, ToolResultPayload } from '../types';

const SUMMARY_CHARS = 60; // 参数/结果摘要截断字数

/** 按工具调用 id 索引（跨消息流条目）。 */
const opIndex = new Map<string, ToolCardRef>();
let toolStep = 0;

/** 当前工具步骤数（供状态栏 step 显示）。 */
export function getToolStep(): number {
  return toolStep;
}

/** 清空会话/切换会话时复位（resetMessages 调用）。 */
export function resetToolCards(): void {
  opIndex.clear();
  toolStep = 0;
}

/**
 * W263：新一轮开始时把当前轮工具步数清零（每个 tool 事件 +1）。
 * 与 resetToolCards 的区别：只清计数器，保留 opIndex —— 迟到/跨轮到达的
 * tool_result 仍能按 id 回填到已渲染的卡片上。
 */
export function resetTurnStep(): void {
  toolStep = 0;
}

function toJsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function summaryOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= SUMMARY_CHARS) return t;
  return t.slice(0, SUMMARY_CHARS) + '…';
}


/** 工具卡构建数据（live 事件与历史恢复共用）。 */
export interface ToolCardData {
  step: number;
  name: string;
  argsText: string; // 参数全文
}

/** 已构建的工具卡引用（供结果回填 / 复制）。 */
export interface ToolCardRef {
  col: HTMLElement;
  card: HTMLElement;
  label: HTMLElement;
  resultPv: HTMLElement;
  body: HTMLElement;
}

/** 构建工具调用卡片 DOM（消息流级条目；live 与恢复渲染共用同一款式）。 */
export function buildToolCard(d: ToolCardData): ToolCardRef {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '工具'));
  cap.appendChild(el('span', null, d.name));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const card = document.createElement('details');
  card.className = 'toolcard running';
  const head = document.createElement('summary');
  head.className = 'toolcard-head';
  head.setAttribute('aria-expanded', 'false');
  const row1 = el('div', 'toolcard-row1');
  row1.appendChild(el('span', 'step-tag', 'step ' + d.step));
  row1.appendChild(el('span', 'toolcard-name', d.name));
  const state = el('span', 'toolcard-state');
  state.innerHTML = '<span class="ts-dot"></span><span class="ts-label">运行中</span>';
  row1.appendChild(state);
  const copyBtn = el('button', 'toolcard-copy', '复制') as HTMLButtonElement;
  copyBtn.type = 'button';
  copyBtn.title = '复制参数与结果（JSON）';
  copyBtn.addEventListener('click', (e) => {
    e.preventDefault(); // 阻止 summary 切换展开
    e.stopPropagation();
    const outEl = card.querySelector<HTMLElement>('.tool-out');
    const text = d.argsText + '\n' + (outEl?.textContent ?? '');
    void navigator.clipboard.writeText(text).catch(() => {
      /* clipboard unavailable */
    });
  });
  row1.appendChild(copyBtn);
  head.appendChild(row1);
  const argsPv = el('div', 'toolcard-args-preview');
  const a = summaryOf(d.argsText);
  argsPv.textContent = a ? '参数：' + a : '参数：—';
  head.appendChild(argsPv);
  const resultPv = el('div', 'toolcard-result-preview');
  resultPv.textContent = '';
  head.appendChild(resultPv);
  card.appendChild(head);
  // 展开后可见：参数全文（平铺，无需二级展开）
  const body = el('div', 'toolcard-body');
  body.appendChild(el('div', 'tool-args', d.argsText));
  card.appendChild(body);
  // 整卡单击展开/收起详情：同步 aria-expanded
  card.addEventListener('toggle', () => {
    head.setAttribute('aria-expanded', card.open ? 'true' : 'false');
  });
  bubble.appendChild(card);
  msg.appendChild(bubble);
  col.appendChild(msg);
  return {
    col,
    card,
    label: state.querySelector<HTMLElement>('.ts-label') ?? state,
    resultPv,
    body,
  };
}

/** 回填工具结果（结果预览行 + 展开区全文 + 完成/失败态）。 */
export function setToolResult(ref: ToolCardRef, resultText: string, failed: boolean): void {
  ref.card.classList.remove('running');
  ref.card.classList.add(failed ? 'err' : 'ok');
  ref.label.textContent = failed ? '失败' : '完成';
  const r = summaryOf(resultText);
  ref.resultPv.textContent = r ? '结果：' + r : '';
  if (r) ref.resultPv.classList.add('has');
  if (!ref.body.querySelector('.tool-out')) {
    ref.body.appendChild(el('div', 'tool-out' + (failed ? ' err-c' : ''), resultText));
  }
}

/** 新建工具调用卡片（live 事件；按事件时间插入消息流尾部）。 */
export function pushToolCard(p: ToolPayload): HTMLElement {
  toolStep += 1;
  const ref = buildToolCard({ step: toolStep, name: String(p.name || 'tool'), argsText: toJsonText(p.args) });
  const MsgsEl = document.getElementById('messages');
  if (MsgsEl) MsgsEl.appendChild(ref.col);
  autoscroll();
  opIndex.set(String(p.id), ref);
  return ref.col;
}

/** 应用工具结果：状态/结果摘要/结果全文（按 id 索引）。 */
export function applyToolResult(p: ToolResultPayload): void {
  const rec = opIndex.get(String(p.id));
  if (!rec) return;
  const failed = p.ok === false || !!p.error;
  const label = failed
    ? '失败'
    : p.decision === 'deny'
      ? '拒绝'
      : p.decision === 'ask'
        ? '待确认'
        : '完成';
  setToolResult(rec, p.error ? String(p.error) : toJsonText(p.value), failed || p.decision === 'deny');
  rec.label.textContent = label;
  autoscroll();
}
