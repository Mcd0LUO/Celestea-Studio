// ============================================================================
// ui/grants/panel.ts — 状态栏盾牌（三态）+ 权限面板（设计 §3.1/§3.2）
//   （W748 从 ui/grants.ts 拆出；纯搬运，DOM 结构/类名/文案/事件未改。）
//   面板 = 复用 statusline 的 .sl-popup 样式族 + utils/overlays 的 Esc 层级栈。
//   授予/撤销动作本身不在本模块（见 ./flow.ts），经 GrantsHost 回调触发。
// ============================================================================
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay } from '../../utils/overlays';
import type { GrantEntry, GrantScope, GrantCap } from '../../types';
import {
  CAPS,
  TTL_CHOICES,
  hhmm,
  isExpired,
  listOf,
  nowSec,
  scopeOf,
  type CapDef,
} from './caps';
import {
  drafts,
  getData,
  getPanelEl,
  getPanelNote,
  getPanelOverlay,
  getShieldBadge,
  getShieldButton,
  inlineError,
  setPanelEl,
  setPanelNote,
  setPanelOverlay,
  ttlPick,
  type GrantsHost,
} from './state';

/** 生效中的放宽项（已过期的不计；§3.2）。 */
function activeGrants(): GrantEntry[] {
  return (getData()?.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
}

function activeFor(cap: GrantCap): GrantEntry | null {
  const list = activeGrants().filter((g) => g.cap === cap);
  return list.length ? list[list.length - 1]! : null;
}

function expiredFor(cap: GrantCap): GrantEntry[] {
  return (getData()?.grants ?? []).filter((g) => g.cap === cap && isExpired(g));
}

/** 即将失效阈值（秒）：盾牌上的小圆点（设计 §3.1）。 */
const EXPIRING_SEC = 120;

// ---- 盾牌按钮（§3.1 三态） -----------------------------------------------------

export function renderShield(): void {
  const btn = getShieldButton();
  if (!btn) return;
  const active = activeGrants();
  const count = active.length;
  const expiring = active.some(
    (g) =>
      typeof g.expires_at === 'number' && g.expires_at > 0 && g.expires_at - nowSec() < EXPIRING_SEC,
  );
  btn.classList.toggle('granted', count > 0);
  btn.classList.toggle('has-expiring', count > 0 && expiring);
  const badge = getShieldBadge();
  if (badge) badge.textContent = count > 0 ? String(count) : '';
  btn.title =
    count === 0
      ? '本会话权限：默认（仅工作区，无网络）'
      : expiring
        ? '本会话有权限即将失效 · 点击查看'
        : '本会话已放宽 ' + count + ' 项权限 · 点击查看';
  btn.setAttribute('aria-label', btn.title);
}

// ---- 面板（§3.2） --------------------------------------------------------------

export function closePanel(): void {
  const overlay = getPanelOverlay();
  if (overlay) {
    popOverlay(overlay);
    setPanelOverlay(null);
  }
  const panelEl = getPanelEl();
  if (panelEl) {
    panelEl.remove();
    setPanelEl(null);
  }
}

export function togglePanel(host: GrantsHost): void {
  if (getPanelEl()) {
    closePanel();
    return;
  }
  void openPanel(host);
}

export async function openPanel(host: GrantsHost): Promise<void> {
  closePanel();
  inlineError.clear();
  setPanelNote(null);
  const domHost = document.getElementById('statusline');
  if (!domHost) return;
  const popup = el('div', 'sl-popup grant-popup');
  popup.setAttribute('role', 'dialog');
  setPanelEl(popup);
  domHost.appendChild(popup);
  setPanelOverlay(pushOverlay(() => closePanel()));

  popup.appendChild(el('div', 'sl-popup-title', '本会话权限'));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);
  body.appendChild(el('div', 'sl-popup-loading', '正在读取当前权限…'));

  if (host.focusedSession() === '') {
    body.replaceChildren(
      el('div', 'sl-popup-note', '尚未打开任何会话：请先在左侧选择一个会话。'),
    );
    return;
  }
  await host.refresh(true);
  if (getPanelEl() !== popup) return; // 期间被关闭
  renderPanel(host);
}

/** 面板整体重绘：离屏构建 + 单次替换（铁律 1）。 */
export function renderPanel(host: GrantsHost): void {
  const popup = getPanelEl();
  if (!popup) return;
  const body = popup.querySelector<HTMLElement>('.sl-popup-body');
  if (!body) return;
  const off = document.createElement('div');

  off.appendChild(
    el('div', 'grant-intro', '默认情况下，本会话只能读写工作区目录，不能访问网络。'),
  );
  off.appendChild(
    el(
      'div',
      'grant-intro',
      '以下授权只对当前会话生效，可随时撤销；变更将在会话下一轮开始时生效。',
    ),
  );

  // 结果预览（§3.4）：把「能力」翻译成「这个会话接下来能做什么」。
  const preview = el('div', 'grant-preview');
  preview.appendChild(el('span', 'grant-preview-label', '结果预览'));
  preview.appendChild(el('span', null, previewText()));
  off.appendChild(preview);

  if (getData() === null) {
    off.appendChild(
      el('div', 'sl-popup-note', '当前无法读取本会话权限，请稍后重试。'),
    );
  } else {
    for (const def of CAPS) {
      if (def.cap === 'unsandboxed' && getData()?.unsandboxed_available !== true) continue;
      off.appendChild(renderRow(def, host));
    }
  }

  const foot = el('div', 'grant-foot');
  foot.appendChild(
    el('div', 'grant-foot-note', '变更将在会话下一轮开始时生效。'),
  );
  const all = el('button', 'btn-mini grant-danger-btn', '全部撤销') as HTMLButtonElement;
  all.type = 'button';
  all.disabled = activeGrants().length === 0;
  all.addEventListener('click', () => void host.revoke(null));
  foot.appendChild(all);
  off.appendChild(foot);

  const note = getPanelNote();
  if (note) off.appendChild(el('div', 'sl-popup-status ' + note.cls, note.text));
  body.replaceChildren(...off.childNodes);
}

/** 当前生效集 → 一句话预览（固定常量句式，范围值只作数据填入）。 */
function previewText(): string {
  const active = activeGrants();
  if (!active.length) return '本会话现在只能读写工作区目录，不能访问网络。';
  const parts: string[] = [];
  for (const def of CAPS) {
    const g = activeFor(def.cap);
    if (!g) continue;
    parts.push(phraseFor(def, scopeOf(g)));
  }
  if (!parts.length) return '本会话现在只能读写工作区目录，不能访问网络。';
  return '本会话现在可以：' + parts.join('；') + '。除此之外的权限与现在相同。';
}

/** 单项能力的「可以做什么」短语（固定句式 + 范围数据）。 */
export function phraseFor(def: CapDef, scope: GrantScope): string {
  switch (def.cap) {
    case 'network':
      return '访问互联网与内网';
    case 'write_roots':
      return '在 ' + listOf(scope.roots).join('、') + ' 中创建与修改文件';
    case 'read_roots':
      return '读取 ' + listOf(scope.roots).join('、') + ' 中的文件';
    case 'net_hosts':
      return '访问 ' + listOf(scope.hosts).join('、');
    case 'tool_extra':
      return '使用额外工具 ' + listOf(scope.tools).join('、');
    case 'unsandboxed':
      return '不经额外隔离运行命令';
  }
}

function maxTtlOf(def: CapDef): number {
  const v = getData()?.max_ttl_sec?.[def.cap];
  return typeof v === 'number' && v > 0 ? v : def.maxTtl;
}

export function ttlOf(def: CapDef): number {
  const picked = ttlPick.get(def.cap);
  const max = maxTtlOf(def);
  const v = picked ?? Math.min(def.defaultTtl, max);
  return Math.min(v, max);
}

/** 一行 = 能力名 + 状态徽标 + 一句话影响 + （范围明细）+ 动作按钮（§3.2）。 */
function renderRow(def: CapDef, host: GrantsHost): HTMLElement {
  const active = activeFor(def.cap);
  const expired = expiredFor(def.cap);
  const row = el('div', 'grant-row' + (active === null && expired.length ? ' expired' : ''));
  row.dataset.cap = def.cap;

  const head = el('div', 'grant-row-head');
  head.appendChild(el('span', 'grant-row-name', def.label));
  head.appendChild(badgeFor(def, active, expired));
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
