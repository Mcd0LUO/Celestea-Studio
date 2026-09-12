// ============================================================================
// ui/grants/panel/rows.ts — 逐项能力明细行（设计 §3.2；W760 从 ../panel.ts 拆出）。
//
//   一行 = 能力名 + 状态徽标 + 一句话影响 +（范围明细）+ 动作按钮；站点/工具类在未
//   授予时带输入框（草稿存 state.drafts）。文案里的范围值只作数据填入，句式是常量。
//   W760 只搬家：DOM 结构、类名、徽标文案、过期行措辞逐字未改。
// ============================================================================
import { el } from '../../../utils/dom';
import type { GrantEntry } from '../../../types';
import { TTL_CHOICES, hhmm, listOf, scopeOf, type CapDef } from '../caps';
import { drafts, inlineError, ttlPick, type GrantsHost } from '../state';
import { activeFor, expiredFor } from './active';
import { maxTtlOf, ttlOf } from './phrase';
import { netHostsIneffective } from './warnings';

/** 一行 = 能力名 + 状态徽标 + 一句话影响 + （范围明细）+ 动作按钮（§3.2）。 */
export function renderRow(def: CapDef, host: GrantsHost): HTMLElement {
  const active = activeFor(def.cap);
  const expired = expiredFor(def.cap);
  const row = el('div', 'grant-row' + (active === null && expired.length ? ' expired' : ''));
  row.dataset.cap = def.cap;

  const head = el('div', 'grant-row-head');
  head.appendChild(el('span', 'grant-row-name', def.label));
  head.appendChild(badgeFor(def, active, expired));
  if (def.cap === 'net_hosts' && netHostsIneffective()) {
    const mark = el('span', 'grant-badge', '当前部署下不生效');
    mark.title = '本部署未启用站点策略，这份站点清单不会改变会话可访问的范围。';
    head.appendChild(mark);
  }
  row.appendChild(head);

  row.appendChild(el('div', 'grant-impact', def.impact));
  if (def.extra) row.appendChild(el('div', 'grant-impact', def.extra));

  const scope = scopeOf(active);
  const values = listOf(scope.roots).concat(listOf(scope.hosts), listOf(scope.tools));
  if (active && values.length) {
    row.appendChild(el('div', 'grant-detail', detailFor(def, active, values)));
  }
  for (const g of expired) {
    const v = listOf(scopeOf(g).roots).concat(listOf(scopeOf(g).hosts), listOf(scopeOf(g).tools));
    row.appendChild(
      el('div', 'grant-detail', '已过期：' + (v.length ? v.join('、') : def.label)),
    );
  }

  if ((def.kind === 'hosts' || def.kind === 'tools') && !active) {
    const box = el('div', 'grant-hosts-row');
    const input = el('input', 'grant-input cfg-input') as HTMLInputElement;
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder =
      def.kind === 'hosts' ? '站点或网段，用逗号或换行分隔' : '工具名，用逗号或换行分隔';
    input.value = drafts.get(def.cap) ?? '';
    input.addEventListener('input', () => {
      drafts.set(def.cap, input.value);
      inlineError.delete(def.cap);
      const err = row.querySelector<HTMLElement>('.grant-err');
      if (err) err.remove();
    });
    box.appendChild(input);
    row.appendChild(box);
  }

  const actions = el('div', 'grant-row-actions');
  if (active) {
    const rev = el('button', 'btn-mini', '撤销') as HTMLButtonElement;
    rev.type = 'button';
    rev.addEventListener('click', () => void host.revoke(def.cap));
    actions.appendChild(rev);
  } else {
    actions.appendChild(ttlSelect(def));
    const grant = el(
      'button',
      'btn-mini' + (def.danger ? ' grant-danger-btn' : ''),
      def.kind === 'dirs' ? '选择目录' : '授予',
    ) as HTMLButtonElement;
    grant.type = 'button';
    grant.addEventListener('click', () => void host.startGrant(def));
    actions.appendChild(grant);
    if (def.cap === 'unsandboxed') {
      actions.appendChild(el('span', 'grant-impact', '15 分钟后失效，且只能使用一次'));
    }
  }
  row.appendChild(actions);

  const err = inlineError.get(def.cap);
  if (err) row.appendChild(el('div', 'grant-err', err));
  return row;
}

function badgeFor(def: CapDef, active: GrantEntry | null, expired: GrantEntry[]): HTMLElement {
  if (active) {
    const badge = el('span', 'grant-badge on', badgeText(def, active));
    return badge;
  }
  if (expired.length) return el('span', 'grant-badge expired', '已过期');
  return el('span', 'grant-badge', '未授予');
}

function badgeText(def: CapDef, g: GrantEntry): string {
  const exp = typeof g.expires_at === 'number' && g.expires_at > 0 ? '至 ' + hhmm(g.expires_at) : '';
  if (def.kind === 'hosts' || def.kind === 'tools') {
    const n = listOf(scopeOf(g)[def.kind === 'hosts' ? 'hosts' : 'tools']).length;
    return '已授予 ' + (n || 1) + ' 项';
  }
  return exp ? '已授予' + exp : '已授予';
}

function detailFor(def: CapDef, g: GrantEntry, values: string[]): string {
  const exp = typeof g.expires_at === 'number' && g.expires_at > 0 ? '（至 ' + hhmm(g.expires_at) + '）' : '';
  switch (def.cap) {
    case 'write_roots':
      return values.join('、') + ' — 已允许在其中创建与修改文件' + exp;
    case 'read_roots':
      return values.join('、') + ' — 已允许读取（不能修改）' + exp;
    case 'net_hosts':
      return values.join('、') + exp;
    case 'tool_extra':
      return values.join('、') + exp;
    default:
      return values.join('、') + exp;
  }
}

function ttlSelect(def: CapDef): HTMLElement {
  const max = maxTtlOf(def);
  const sel = document.createElement('select');
  sel.className = 'cfg-input grant-ttl';
  const cur = ttlOf(def);
  let matched = false;
  for (const c of TTL_CHOICES) {
    if (c.sec > max) continue;
    const o = document.createElement('option');
    o.value = String(c.sec);
    o.textContent = '有效期 ' + c.label;
    if (c.sec === cur) matched = true;
    sel.appendChild(o);
  }
  if (!matched) {
    const o = document.createElement('option');
    o.value = String(max);
    o.textContent = '有效期 ' + Math.max(1, Math.round(max / 60)) + ' 分钟';
    sel.appendChild(o);
    sel.value = String(max);
  } else {
    sel.value = String(cur);
  }
  sel.addEventListener('change', () => ttlPick.set(def.cap, Number(sel.value)));
  return sel;
}
