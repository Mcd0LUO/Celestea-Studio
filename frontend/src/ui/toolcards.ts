// ============================================================================
// ui/toolcards.ts — 工具调用卡片（W239 任务 3+4；W514 多会话化）：
//   工具事件按发生时间与 user/assistant 消息交错内联，作为消息流级条目
//   （.mcol.msg.tool）插入「该会话自己的视图容器」（SessionPane.el）。
//   W514：索引（tool_call_id → 卡片）与步数由全局单例改为每容器一份，
//         后台会话的工具卡回填不会污染当前视图。
// ============================================================================
import { el } from '../utils/dom';
import { autoscroll } from './messages';
import type { SessionPane } from './viewctx';
import type { ToolCardRef } from './view';
import type { ToolPayload, ToolResultPayload } from '../types';

export type { ToolCardRef };

const SUMMARY_CHARS = 60; // 参数/结果摘要截断字数

/** 当前工具步骤数（供状态栏 step 显示）。 */
export function getToolStep(ctx: SessionPane): number {
  return ctx.step;
}

/** 清空会话/切换会话时复位（resetMessages 调用）。 */
export function resetToolCards(ctx: SessionPane): void {
  ctx.ops.clear();
  ctx.step = 0;
}

/**
 * W263：新一轮开始时把当前轮工具步数清零（每个 tool 事件 +1）。
 * 与 resetToolCards 的区别：只清计数器，保留 opIndex —— 迟到/跨轮到达的
 * tool_result 仍能按 id 回填到已渲染的卡片上。
 */
export function resetTurnStep(ctx: SessionPane): void {
  ctx.step = 0;
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
  row1.appendChild(el('span', 'step-tag', '第 ' + d.step + ' 步'));
  row1.appendChild(el('span', 'toolcard-name', d.name));
  const state = el('span', 'toolcard-state');
  // W739：改用离屏构建（原静态 innerHTML 赋值是纯字面量，无注入面，但收敛写入点）
  state.appendChild(el('span', 'ts-dot'));
  state.appendChild(el('span', 'ts-label', '运行中'));
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
  const body = el('div', 'toolcard-body');
  body.appendChild(el('div', 'tool-args', d.argsText));
  card.appendChild(body);
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

/** 新建工具调用卡片（live 事件；按事件时间插入该会话视图尾部）。 */
export function pushToolCard(ctx: SessionPane, p: ToolPayload, into?: HTMLElement): HTMLElement {
  ctx.step += 1;
  const ref = buildToolCard({
    step: ctx.step,
    name: String(p.name || 'tool'),
    argsText: toJsonText(p.args),
  });
  (into ?? ctx.el).appendChild(ref.col);
  if (!into) autoscroll(ctx);
  ctx.ops.set(String(p.id), ref);
  return ref.col;
}

/** 应用工具结果：状态/结果摘要/结果全文（按 id 索引，索引属于该会话）。 */
export function applyToolResult(ctx: SessionPane, p: ToolResultPayload): void {
  const rec = ctx.ops.get(String(p.id));
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
  autoscroll(ctx);
}
