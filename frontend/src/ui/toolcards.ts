// ============================================================================
// 工具调用卡：tool 事件创建卡片（含参数折叠），tool_result 更新状态与结果。
// ============================================================================
import { el } from '../utils/dom';
import type { AssistantView, ToolOpView } from '../state';
import type { ToolPayload, ToolResultPayload } from '../types';
import { autoscroll } from './messages';

/** Render a new tool-call card; returns the card element. */
export function pushToolCard(view: AssistantView, p: ToolPayload): HTMLDivElement {
  const idx = ++view.steps;

  const card = el('div', 'toolcard running');
  card.dataset.toolId = String(p.id);

  const head = el('div', 'toolcard-head');
  head.appendChild(el('span', 'step-tag', 'step ' + idx));
  head.appendChild(el('span', 'toolcard-name', String(p.name || 'tool')));
  const state = el('span', 'toolcard-state', undefined);
  state.innerHTML = '<span class="ts-dot"></span><span class="ts-label">运行中</span>';
  head.appendChild(state);
  card.appendChild(head);

  const argsDetails = document.createElement('details');
  argsDetails.className = 'tool-details';
  const argsSummary = el('summary', null, '参数');
  argsSummary.style.listStyle = 'none';
  argsDetails.appendChild(argsSummary);
  const argsBody = el('div', 'tool-args');
  argsBody.textContent = toJsonText(p.args);
  argsDetails.appendChild(argsBody);
  card.appendChild(argsDetails);

  const op: ToolOpView = {
    card,
    state,
    label: state.querySelector<HTMLElement>('.ts-label') ?? state,
  };

  view.cards.appendChild(card);
  view.ops.set(String(p.id), op);
  autoscroll();
  return card;
}

/** Apply a tool_result payload onto the matching card. */
export function applyToolResult(view: AssistantView, p: ToolResultPayload): void {
  const op = view.ops.get(String(p.id));
  if (!op) return;

  const failed = p.ok === false || !!p.error;
  const kind: 'ok' | 'err' | 'deny' = failed ? 'err' : p.decision === 'deny' ? 'deny' : 'ok';
  const label = failed
    ? '失败'
    : p.decision === 'deny'
      ? '拒绝'
      : p.decision === 'ask'
        ? '待确认'
        : '完成';

  op.card.classList.remove('running');
  op.card.classList.add(kind === 'ok' ? 'ok' : 'err'); // deny uses err palette
  op.label.textContent = label;

  const bodyText = resultText(p);
  const preview = bodyText.length > 64 ? bodyText.slice(0, 64) + '…' : bodyText || '（空）';
  const resDetails = document.createElement('details');
  resDetails.className = 'tool-details';
  const resSummary = el('summary', null, (failed ? '错误 · ' : '结果 · ') + preview);
  resDetails.appendChild(resSummary);
  const out = el('div', 'tool-out' + (failed ? ' err-c' : ''));
  out.textContent = bodyText || '（空）';
  resDetails.appendChild(out);
  op.card.appendChild(resDetails);
  autoscroll();
}

function resultText(p: ToolResultPayload): string {
  if (p.error) return String(p.error);
  if (p.render !== undefined && p.render !== null) return String(p.render);
  if (p.value !== undefined && p.value !== null) return toJsonText(p.value);
  return '';
}

function toJsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
