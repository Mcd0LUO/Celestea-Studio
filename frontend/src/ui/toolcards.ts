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

interface OpRec {
  card: HTMLElement;
  state: HTMLElement;
  label: HTMLElement;
  resultPreview: HTMLElement;
}

/** 按工具调用 id 索引（跨消息流条目）。 */
const opIndex = new Map<string, OpRec>();
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

/** 参数一行摘要（截断 ~60 字）。 */
function argsSummary(args: unknown): string {
  const t = toJsonText(args);
  return t ? summaryOf(t) : '';
}

/** 结果一行摘要（value 首行截断 ~60 字）。 */
function resultSummary(p: ToolResultPayload): string {
  if (p.error) return 'Error: ' + summaryOf(String(p.error));
  const raw = p.value !== undefined && p.value !== null ? toJsonText(p.value) : p.render;
  if (!raw) return '';
  const first = String(raw).split('\n')[0] ?? '';
  return summaryOf(first);
}

/** 新建工具调用卡片（消息流级条目，按事件时间插入消息流尾部）。 */
export function pushToolCard(p: ToolPayload): HTMLElement {
  toolStep += 1;

  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '工具'));
  cap.appendChild(el('span', null, String(p.name || 'tool')));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const card = document.createElement('details');
  card.className = 'toolcard running';
  card.dataset.toolId = String(p.id);

  const head = document.createElement('summary');
  head.className = 'toolcard-head';
  const row1 = el('div', 'toolcard-row1');
  row1.appendChild(el('span', 'step-tag', 'step ' + toolStep));
  row1.appendChild(el('span', 'toolcard-name', String(p.name || 'tool')));
  const state = el('span', 'toolcard-state');
  state.innerHTML = '<span class="ts-dot"></span><span class="ts-label">运行中</span>';
  row1.appendChild(state);
  head.appendChild(row1);
  const argsPv = el('div', 'toolcard-args-preview');
  const a = argsSummary(p.args);
  argsPv.textContent = a ? '参数：' + a : '参数：—';
  head.appendChild(argsPv);
  const resultPv = el('div', 'toolcard-result-preview');
  resultPv.textContent = '';
  head.appendChild(resultPv);
  card.appendChild(head);

  // 展开后可见：参数全文
  const body = el('div', 'toolcard-body');
  const argsDet = document.createElement('details');
  argsDet.className = 'tool-details';
  argsDet.appendChild(el('summary', null, '参数'));
  argsDet.appendChild(el('div', 'tool-args', toJsonText(p.args)));
  body.appendChild(argsDet);
  card.appendChild(body);

  bubble.appendChild(card);
  msg.appendChild(bubble);
  col.appendChild(msg);
  const MsgsEl = document.getElementById('messages');
  if (MsgsEl) MsgsEl.appendChild(col);
  autoscroll();

  opIndex.set(String(p.id), { card: col, state, label: state.querySelector<HTMLElement>('.ts-label') ?? state, resultPreview: resultPv });
  return col;
}

/** 应用工具结果：状态/结果摘要/结果全文（按 id 索引）。 */
export function applyToolResult(p: ToolResultPayload): void {
  const rec = opIndex.get(String(p.id));
  if (!rec) return;

  const failed = p.ok === false || !!p.error;
  const kind: 'ok' | 'err' | 'deny' = failed ? 'err' : p.decision === 'deny' ? 'deny' : 'ok';
  const label = failed
    ? '失败'
    : p.decision === 'deny'
      ? '拒绝'
      : p.decision === 'ask'
        ? '待确认'
        : '完成';

  const card = rec.card.querySelector<HTMLElement>('.toolcard');
  card?.classList.remove('running');
  card?.classList.add(kind === 'ok' ? 'ok' : 'err'); // deny uses err palette
  rec.label.textContent = label;

  const r = resultSummary(p);
  rec.resultPreview.textContent = r ? '结果：' + r : '';
  if (r) rec.resultPreview.classList.add('has');

  // 展开区：结果全文
  const body = card?.querySelector<HTMLElement>('.toolcard-body');
  if (body) {
    const res = document.createElement('details');
    res.className = 'tool-details';
    res.appendChild(el('summary', null, failed ? '错误' : '结果'));
    const out = el('div', 'tool-out' + (failed ? ' err-c' : ''), p.error ? String(p.error) : toJsonText(p.value));
    res.appendChild(out);
    body.appendChild(res);
  }
  autoscroll();
}
