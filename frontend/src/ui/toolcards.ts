// ============================================================================
// ui/toolcards.ts — 工具调用卡（单一职责）：
//   默认收起 = 一行（step · 名称 · 状态）；点开查看参数 / 结果详情。
// tool 事件创建卡片；tool_result 事件更新状态与结果。
// ============================================================================
import { el } from '../utils/dom';
import type { AssistantView, ToolOpView } from './view';
import type { ToolPayload, ToolResultPayload } from '../types';
import { autoscroll } from './messages';

/** Render a new tool-call card; returns the card element. */
export function pushToolCard(view: AssistantView, p: ToolPayload): HTMLDetailsElement {
  const idx = ++view.steps;

  // 整卡用 <details>：summary = 一行（step · 名称 · 状态），body = 参数/结果
  const card = document.createElement('details');
  card.className = 'toolcard running';
  card.dataset.toolId = String(p.id);

  const head = document.createElement('summary');
  head.className = 'toolcard-head';
  head.appendChild(el('span', 'step-tag', 'step ' + idx));
  head.appendChild(el('span', 'toolcard-name', String(p.name || 'tool')));
  const state = el('span', 'toolcard-state', undefined);
  state.innerHTML = '<span class="ts-dot"></span><span class="ts-label">运行中</span>';
  head.appendChild(state);
  card.appendChild(head);

  const body = el('div', 'toolcard-body');
  const args = document.createElement('details');
  args.className = 'tool-details';
  args.appendChild(el('summary', null, '参数'));
  const argsOut = el('div', 'tool-args', toJsonText(p.args));
  args.appendChild(argsOut);
  body.appendChild(args);
  card.appendChild(body);

  view.cards.appendChild(card);

  const op: ToolOpView = {
    card,
    state,
    label: state.querySelector<HTMLElement>('.ts-label') ?? state,
  };

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

  const body = op.card.querySelector<HTMLElement>('.toolcard-body');
  if (body) {
    const res = document.createElement('details');
    res.className = 'tool-details';
    res.appendChild(el('summary', null, failed ? '错误' : '结果'));
    const out = el('div', 'tool-out' + (failed ? ' err-c' : ''), resultText(p) || '（空）');
    res.appendChild(out);
    body.appendChild(res);
  }
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
