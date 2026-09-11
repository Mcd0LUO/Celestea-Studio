// ============================================================================
// ui/grants.ts — W701 提权通道 UI（本会话权限盾牌）
//
//   入口：状态栏右侧盾牌按钮（index.html #slGrant），三态（设计 §3.1）：
//     未授予 = 灰色空心盾 · 已授予 = 橙实心盾 + 角标数字 · 即将失效(<2min) = 橙盾 + 圆点。
//   面板：复用 utils/overlays 的 Esc 层级栈 + statusline 的 .sl-popup 样式族（§3.2）。
//   危险能力二次确认：ui/confirm.ts 的 confirmDialog({danger:true}) + 输入确认词（§3.3）。
//   结果预览：确认弹窗**原样**展示服务返回的生效快照，绝不自行拼措辞（§3.4）。
//   令牌流程：POST 前先取一次性确认令牌（TTL 60s），带 X-Celestea-Grant-Confirm 头提交（§5.5）。
//   降级：能力位 capabilities.grants !== true → 入口**隐藏**（不置灰报错，§6.5）。
//
//   文案纪律（安全不变量）：本文件所有面向用户的字符串都是**固定常量**，
//   绝不采用工具输出或模型文本中的任何字符串 —— 否则模型可伪造一个无害的
//   「确认」按钮。范围值（路径/站点/工具名）只作为**数据**填入固定句式。
// ============================================================================
import { api, ApiError, userErrorText } from '../api';
import { S } from '../state';
import type {
  EffectiveGrants,
  GrantCap,
  GrantEntry,
  GrantReq,
  GrantScope,
  GrantsResp,
} from '../types';
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import { confirmDialog } from './confirm';
import { pickDirectory } from './fsbrowser';
import { flashStatus } from './statusbar';
import { activeSessionId, onPaneChange } from './viewctx';

/** 放宽标记变化事件（侧栏会话叶子订阅；只做局部更新）。 */
export const GRANTS_CHANGED_EVENT = 'studio:grants-changed';

/** 即将失效阈值（秒）：盾牌上的小圆点（设计 §3.1）。 */
const EXPIRING_SEC = 120;
/** 面板打开时的刷新节奏（秒）；只更新盾牌与面板，不触碰其它视图。 */
const POLL_MS = 20000;
/** 侧栏标记的按需查询结果缓存时长。 */
const MARK_TTL_MS = 120000;
const SCAN_CONCURRENCY = 3;
const SCAN_MAX = 40;

/** 危险能力（侧栏红色小盾 + 二次确认 + 确认词，设计 §3.1/§3.3）。 */
const DANGER_CAPS: ReadonlySet<string> = new Set(['network', 'write_roots', 'unsandboxed']);

/** 每项能力的用户语言定义（名称 / 一句话影响 / 表单形态；文案逐字取自设计 §3.2）。 */
interface CapDef {
  cap: GrantCap;
  label: string;
  impact: string;
  /** 追加的影响说明（如「撤销前一直有效」）。 */
  extra?: string;
  /** bool = 无范围；dirs = 选目录；hosts = 站点文本框；tools = 工具名文本框。 */
  kind: 'bool' | 'dirs' | 'hosts' | 'tools';
  danger: boolean;
  /** 需要逐字输入的确认词（设计 §3.3）；空串 = 只需点击确认。 */
  confirmWord: string;
  /** 文档默认有效期与上限（秒）；服务返回 max_ttl_sec 时以上限为准（§2.3）。 */
  defaultTtl: number;
  maxTtl: number;
}

const CAPS: readonly CapDef[] = [
  {
    cap: 'network',
    label: '访问网络',
    impact: '允许会话中运行的命令访问互联网与内网（含本机服务）。',
    extra: '⚠ 撤销前一直有效。',
    kind: 'bool',
    danger: true,
    confirmWord: '允许',
    defaultTtl: 1800,
    maxTtl: 3600,
  },
  {
    cap: 'write_roots',
    label: '额外可写目录',
    impact: '允许会话在所选目录中创建与修改文件。',
    kind: 'dirs',
    danger: true,
    confirmWord: '允许',
    defaultTtl: 1800,
    maxTtl: 86400,
  },
  {
    cap: 'read_roots',
    label: '额外只读目录',
    impact: '允许会话读取该目录内的文件（不能修改）。',
    kind: 'dirs',
    danger: false,
    confirmWord: '',
    defaultTtl: 1800,
    maxTtl: 86400,
  },
  {
    cap: 'net_hosts',
    label: '访问指定网站',
    impact: '放宽会话可访问的站点范围：只对下面列出的站点生效。',
    kind: 'hosts',
    danger: false,
    confirmWord: '',
    defaultTtl: 1800,
    maxTtl: 86400,
  },
  {
    cap: 'tool_extra',
    label: '启用额外工具',
    impact: '启用默认未开放的额外工具（不放行已被拒绝的操作）。',
    kind: 'tools',
    danger: false,
    confirmWord: '',
    defaultTtl: 1800,
    maxTtl: 86400,
  },
  {
    cap: 'unsandboxed',
    label: '降低隔离运行',
    impact: '允许会话中的命令不经额外隔离运行。',
    kind: 'bool',
    danger: true,
    confirmWord: '降低隔离',
    defaultTtl: 900,
    maxTtl: 900,
  },
];

const CAP_BY_NAME = new Map<string, CapDef>(CAPS.map((c) => [c.cap, c]));

/** 有效期选项（秒 → 用户语言标签）。 */
const TTL_CHOICES: readonly { sec: number; label: string }[] = [
  { sec: 900, label: '15 分钟' },
  { sec: 1800, label: '30 分钟' },
  { sec: 3600, label: '1 小时' },
  { sec: 86400, label: '24 小时' },
];

// ---- 会话状态 ------------------------------------------------------------------

export interface GrantMark {
  /** 生效条数（已过期的不计，设计 §3.2）。 */
  count: number;
  /** 是否含危险能力（侧栏红盾）。 */
  danger: boolean;
  caps: string[];
}

/** 能力位：unknown = 尚未探测（此期间不显示入口、不发起任何请求）。 */
let capability: 'unknown' | 'on' | 'off' = 'unknown';
let capProbeAt = 0;
let probeTimer: number | null = null;
let pollTimer: number | null = null;
let wired = false;

let button: HTMLButtonElement | null = null;
let badgeEl: HTMLElement | null = null;

/** 当前聚焦会话的完整权限数据（盾牌/面板的真源）。 */
let data: GrantsResp | null = null;
let dataSession = '';
/** 面板打开状态。 */
let panel: HTMLElement | null = null;
let panelOverlay: OverlayHandle | null = null;
/** 面板级状态行（成功/失败提示）。 */
let panelNote: { text: string; cls: string } | null = null;
/** 就地校验错误（按能力位）。 */
const inlineError = new Map<string, string>();
/** 站点/工具文本框草稿（按能力位；重渲染不丢字）。 */
const drafts = new Map<string, string>();
/** 有效期选择（按能力位）。 */
const ttlPick = new Map<string, number>();

/** 侧栏标记缓存 + 已探测时刻（失败也计时，避免反复打同一个会话）。 */
const marks = new Map<string, GrantMark>();
const probedAt = new Map<string, number>();

// ---- 小工具 --------------------------------------------------------------------

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** unix 秒 → 本地 HH:MM（面板徽标与确认文案共用）。 */
function hhmm(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 生效条数：已过期的不计入（§3.2 / §3.1）。 */
function isExpired(g: GrantEntry): boolean {
  if (g.expired === true) return true;
  if (typeof g.expires_at === 'number' && g.expires_at > 0) return g.expires_at <= nowSec();
  return false;
}

function activeGrants(): GrantEntry[] {
  return (data?.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
}

function activeFor(cap: GrantCap): GrantEntry | null {
  const list = activeGrants().filter((g) => g.cap === cap);
  return list.length ? list[list.length - 1]! : null;
}

function expiredFor(cap: GrantCap): GrantEntry[] {
  return (data?.grants ?? []).filter((g) => g.cap === cap && isExpired(g));
}

function scopeOf(g: GrantEntry | null): GrantScope {
  return g && g.scope && typeof g.scope === 'object' ? g.scope : {};
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 生效快照 → 侧栏标记（不含过期项）。 */
function markFromEffective(eff: EffectiveGrants | undefined): GrantMark {
  const caps: string[] = [];
  if (!eff) return { count: 0, danger: false, caps };
  if (eff.network === true) caps.push('network');
  if (listOf(eff.read_roots).length) caps.push('read_roots');
  if (listOf(eff.write_roots).length) caps.push('write_roots');
  if (listOf(eff.net_hosts).length) caps.push('net_hosts');
  if (listOf(eff.tool_extra).length) caps.push('tool_extra');
  if (eff.unsandboxed === true) caps.push('unsandboxed');
  return { count: caps.length, danger: caps.some((c) => DANGER_CAPS.has(c)), caps };
}

/** 某会话的放宽标记（未探测到 = null，不显示标记）。 */
export function grantMarkOf(sessionId: string): GrantMark | null {
  const m = marks.get(sessionId);
  return m && m.count > 0 ? m : null;
}

function emitChanged(): void {
  window.dispatchEvent(new Event(GRANTS_CHANGED_EVENT));
}

function setMark(sessionId: string, mark: GrantMark): void {
  if (sessionId === '') return;
  const prev = marks.get(sessionId);
  const same =
    prev !== undefined &&
    prev.count === mark.count &&
    prev.danger === mark.danger &&
    prev.caps.join(',') === mark.caps.join(',');
  if (mark.count > 0) marks.set(sessionId, mark);
  else marks.delete(sessionId);
  if (!same) emitChanged();
}

// ---- 能力位（§6.5 降级） --------------------------------------------------------

function applyCapability(on: boolean): void {
  const next = on ? 'on' : 'off';
  if (capability === next) return;
  capability = next;
  if (button) button.classList.toggle('hidden', !on);
  if (!on) {
    closePanel();
    stopPoll();
    // 入口隐藏即结束：不清空已有标记（避免闪烁），但不再发起任何请求
  } else {
    startPoll();
    void refresh(true);
  }
}

async function probeCapability(force = false): Promise<void> {
  const now = Date.now();
  if (!force && capability !== 'unknown' && now - capProbeAt < 60000) return;
  capProbeAt = now;
  try {
    const h = await api.health();
    applyCapability(h.capabilities?.grants === true);
  } catch {
    // 探测失败 = 不能确认可用 → 按不可用处理（不报错、不崩溃）
    applyCapability(false);
  }
}

// ---- 侧栏标记（按需查询，局部更新） ---------------------------------------------

/** 按需查询若干会话的放宽标记（并发受控；能力位未就绪时为空操作）。 */
export function ensureGrantMarks(ids: readonly string[]): void {
  if (capability !== 'on' || ids.length === 0) return;
  const now = Date.now();
  const queue: string[] = [];
  for (const id of ids) {
    if (!id || queue.includes(id)) continue;
    const at = probedAt.get(id);
    if (at !== undefined && now - at < MARK_TTL_MS) continue;
    queue.push(id);
    if (queue.length >= SCAN_MAX) break;
  }
  if (!queue.length) return;
  let i = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const idx = i++;
      if (idx >= queue.length) return;
      await fetchMark(queue[idx]!);
    }
  };
  for (let k = 0; k < Math.min(SCAN_CONCURRENCY, queue.length); k++) void run();
}

async function fetchMark(sessionId: string): Promise<void> {
  probedAt.set(sessionId, Date.now());
  try {
    const r = await api.grants(sessionId);
    if (r.error) return;
    const active = (r.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
    const caps = active.map((g) => String(g.cap));
    setMark(sessionId, {
      count: active.length,
      danger: caps.some((c) => DANGER_CAPS.has(c)),
      caps,
    });
  } catch {
    // 该会话不可查（已删除 / 能力未就绪）：保持现状，不显示标记、不报错
  }
}

// ---- 聚焦会话数据 --------------------------------------------------------------

function focusedSession(): string {
  const id = activeSessionId();
  if (id !== '') return id;
  return S.selSession ?? '';
}

async function refresh(force = false): Promise<void> {
  if (capability !== 'on') return;
  const id = focusedSession();
  if (id === '') {
    data = null;
    dataSession = '';
    renderShield();
    if (panel) renderPanel();
    return;
  }
  if (!force && panel === null && id === dataSession && data !== null) {
    renderShield();
    return;
  }
  const asked = id;
  try {
    const r = await api.grants(asked);
    if (asked !== focusedSession()) return; // 竞态：期间已切换会话，丢弃
    data = r;
    dataSession = asked;
    probedAt.set(asked, Date.now());
    const active = (r.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
    const caps = active.map((g) => String(g.cap));
    setMark(asked, { count: active.length, danger: caps.some((c) => DANGER_CAPS.has(c)), caps });
  } catch (err) {
    if (asked !== focusedSession()) return;
    if (err instanceof ApiError && err.status === 0) return; // 不可达：静默保留上次数据
    data = null;
    dataSession = asked;
  }
  renderShield();
  if (panel) renderPanel();
}

function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    void refresh(true);
  }, POLL_MS);
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- 盾牌按钮（§3.1 三态） -----------------------------------------------------

function renderShield(): void {
  if (!button) return;
  const active = activeGrants();
  const count = active.length;
  const expiring = active.some(
    (g) =>
      typeof g.expires_at === 'number' && g.expires_at > 0 && g.expires_at - nowSec() < EXPIRING_SEC,
  );
  button.classList.toggle('granted', count > 0);
  button.classList.toggle('has-expiring', count > 0 && expiring);
  if (badgeEl) badgeEl.textContent = count > 0 ? String(count) : '';
  button.title =
    count === 0
      ? '本会话权限：默认（仅工作区，无网络）'
      : expiring
        ? '本会话有权限即将失效 · 点击查看'
        : '本会话已放宽 ' + count + ' 项权限 · 点击查看';
  button.setAttribute('aria-label', button.title);
}

// ---- 面板（§3.2） --------------------------------------------------------------

function closePanel(): void {
  if (panelOverlay) {
    popOverlay(panelOverlay);
    panelOverlay = null;
  }
  if (panel) {
    panel.remove();
    panel = null;
  }
}

function togglePanel(): void {
  if (panel) {
    closePanel();
    return;
  }
  void openPanel();
}

async function openPanel(): Promise<void> {
  closePanel();
  inlineError.clear();
  panelNote = null;
  const host = document.getElementById('statusline');
  if (!host) return;
  const popup = el('div', 'sl-popup grant-popup');
  popup.setAttribute('role', 'dialog');
  panel = popup;
  host.appendChild(popup);
  panelOverlay = pushOverlay(() => closePanel());

  popup.appendChild(el('div', 'sl-popup-title', '本会话权限'));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);
  body.appendChild(el('div', 'sl-popup-loading', '正在读取当前权限…'));

  if (focusedSession() === '') {
    body.replaceChildren(
      el('div', 'sl-popup-note', '尚未打开任何会话：请先在左侧选择一个会话。'),
    );
    return;
  }
  await refresh(true);
  if (panel !== popup) return; // 期间被关闭
  renderPanel();
}

/** 面板整体重绘：离屏构建 + 单次替换（铁律 1）。 */
function renderPanel(): void {
  const popup = panel;
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

  if (data === null) {
    off.appendChild(
      el('div', 'sl-popup-note', '当前无法读取本会话权限，请稍后重试。'),
    );
  } else {
    for (const def of CAPS) {
      if (def.cap === 'unsandboxed' && data.unsandboxed_available !== true) continue;
      off.appendChild(renderRow(def));
    }
  }

  const foot = el('div', 'grant-foot');
  foot.appendChild(
    el('div', 'grant-foot-note', '变更将在会话下一轮开始时生效。'),
  );
  const all = el('button', 'btn-mini grant-danger-btn', '全部撤销') as HTMLButtonElement;
  all.type = 'button';
  all.disabled = activeGrants().length === 0;
  all.addEventListener('click', () => void revoke(null));
  foot.appendChild(all);
  off.appendChild(foot);

  if (panelNote) off.appendChild(el('div', 'sl-popup-status ' + panelNote.cls, panelNote.text));
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
function phraseFor(def: CapDef, scope: GrantScope): string {
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
  const v = data?.max_ttl_sec?.[def.cap];
  return typeof v === 'number' && v > 0 ? v : def.maxTtl;
}

function ttlOf(def: CapDef): number {
  const picked = ttlPick.get(def.cap);
  const max = maxTtlOf(def);
  const v = picked ?? Math.min(def.defaultTtl, max);
  return Math.min(v, max);
}

/** 一行 = 能力名 + 状态徽标 + 一句话影响 + （范围明细）+ 动作按钮（§3.2）。 */
function renderRow(def: CapDef): HTMLElement {
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
    rev.addEventListener('click', () => void revoke(def.cap));
    actions.appendChild(rev);
  } else {
    actions.appendChild(ttlSelect(def));
    const grant = el(
      'button',
      'btn-mini' + (def.danger ? ' grant-danger-btn' : ''),
      def.kind === 'dirs' ? '选择目录' : '授予',
    ) as HTMLButtonElement;
    grant.type = 'button';
    grant.addEventListener('click', () => void startGrant(def));
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

// ---- 授予流程（令牌 + 二次确认 + 结果预览；§3.3/§3.4/§5.5） ----------------------

async function startGrant(def: CapDef): Promise<void> {
  const session = focusedSession();
  if (session === '') return;
  inlineError.delete(def.cap);

  let scope: GrantScope = {};
  if (def.kind === 'dirs') {
    const path = await pickDirectory('选择要放宽的目录', '只能选择目录；有效期结束后权限自动收回');
    if (path === null || path.trim() === '') return;
    scope = { roots: [path.trim()] };
  } else if (def.kind === 'hosts') {
    const v = validateHosts(drafts.get(def.cap) ?? '');
    if (v.error !== '') {
      inlineError.set(def.cap, v.error);
      renderPanel();
      return;
    }
    scope = { hosts: v.values };
  } else if (def.kind === 'tools') {
    const v = validateTools(drafts.get(def.cap) ?? '');
    if (v.error !== '') {
      inlineError.set(def.cap, v.error);
      renderPanel();
      return;
    }
    scope = { tools: v.values };
  }

  const ttl = ttlOf(def);
  const expiresAt = nowSec() + ttl;
  const ok = await confirmDialog({
    title: '确认放宽权限 · ' + def.label,
    message: confirmMessageFor(def, scope, expiresAt),
    note: previewForPending(def, scope) + '\n变更将在会话下一轮开始时生效。',
    snapshot: JSON.stringify(data?.effective ?? {}, null, 2),
    snapshotLabel: '结果预览 · 生效快照（原样取自服务）',
    requireText: def.confirmWord,
    okLabel: '授予',
    danger: true,
  });
  if (!ok) return;

  const req: GrantReq = { cap: def.cap, scope, ttl_sec: ttl };
  if (def.cap === 'unsandboxed') req.uses_left = 1;

  panelNote = { text: '正在提交…', cls: 'busy' };
  renderPanel();
  try {
    const r = await submitGrant(session, def, req, scope);
    if (r === null) return;
    drafts.delete(def.cap);
    panelNote = { text: successText(def, r), cls: 'busy' };
    flashStatus(successText(def, r), 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await refresh(true);
  } catch (err) {
    const text = '放宽失败：' + userErrorText(err, '请稍后重试');
    panelNote = { text, cls: 'err' };
    flashStatus(text, 'err', 8000);
    renderPanel();
  }
}

/** 取一次性令牌（有效期 60 秒）→ POST；令牌失效时重取一枚再试一次。 */
async function submitGrant(
  session: string,
  def: CapDef,
  req: GrantReq,
  scope: GrantScope,
): Promise<{ effective?: EffectiveGrants; grant?: GrantEntry } | null> {
  const scopeHash = await scopeHashOf(def.cap, scope);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await api.grantToken(session, def.cap, scopeHash);
    if (!t.token) throw new ApiError(userErrorText(t.error, '无法发起授权，请稍后重试'));
    try {
      const r = await api.grantCap(session, req, t.token);
      if (r.ok === false) throw new ApiError(userErrorText(r.error, '放宽失败，请稍后重试'));
      return { effective: r.effective, grant: r.grant };
    } catch (err) {
      // 令牌过期/已被使用：重新取一枚再试一次（确认动作本身已经完成）
      if (err instanceof ApiError && (err.status === 403 || err.status === 409) && attempt === 0) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

function successText(
  def: CapDef,
  r: { effective?: EffectiveGrants; grant?: GrantEntry },
): string {
  const exp =
    typeof r.grant?.expires_at === 'number' && r.grant.expires_at > 0
      ? '（至 ' + hhmm(r.grant.expires_at) + '）'
      : '';
  return '已放宽：' + def.label + exp;
}

/** 二次确认正文：逐字取自设计 §3.3 的固定句式，范围值只作数据填入。 */
function confirmMessageFor(def: CapDef, scope: GrantScope, expiresAt: number): string {
  const at = hhmm(expiresAt);
  switch (def.cap) {
    case 'network':
      return (
        '允许本会话中运行的命令访问互联网与内网（包括本机运行的服务）。' +
        '撤销前一直有效（或至 ' +
        at +
        '）。仅在你信任即将运行的命令时授予。'
      );
    case 'write_roots':
      return (
        '允许本会话在 ' +
        listOf(scope.roots).join('、') +
        ' 中创建与修改文件。该目录之外的写入仍然被拒绝。此授权至 ' +
        at +
        '。'
      );
    case 'unsandboxed':
      return (
        '允许本会话中运行的命令绕过文件系统与网络的额外隔离。' +
        '恶意或被注入的命令可能读取或修改你的文件。此授权 15 分钟后失效，且只能使用一次。'
      );
    case 'read_roots':
      return (
        '允许本会话读取 ' + listOf(scope.roots).join('、') + '（不能修改）。此授权至 ' + at + '。'
      );
    case 'net_hosts':
      return '允许本会话访问 ' + listOf(scope.hosts).join('、') + '。';
    case 'tool_extra':
      return '允许本会话使用 ' + listOf(scope.tools).join('、') + '。';
  }
}

/** 授予后的效果预览（§3.4 的固定句式；范围值只作数据填入）。 */
function previewForPending(def: CapDef, scope: GrantScope): string {
  return '授予后，本会话可以：' + phraseFor(def, scope) + '。除此之外的权限与现在相同。';
}

// ---- 撤销（不需要二次确认；§3.3 末段） ------------------------------------------

async function revoke(cap: GrantCap | null): Promise<void> {
  const session = focusedSession();
  if (session === '') return;
  const def = cap ? CAP_BY_NAME.get(cap) : undefined;
  panelNote = { text: '正在撤销…', cls: 'busy' };
  renderPanel();
  try {
    const r = await api.revokeCap(session, cap ? { cap } : {});
    const n = (r.revoked ?? []).length;
    const text = cap && def ? '已撤销：' + def.label : n > 1 ? '已撤销 ' + n + ' 项放宽权限' : '已撤销放宽权限';
    panelNote = { text, cls: 'busy' };
    flashStatus(text, 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await refresh(true);
  } catch (err) {
    const text = '撤销失败：' + userErrorText(err, '请稍后重试');
    panelNote = { text, cls: 'err' };
    flashStatus(text, 'err', 8000);
    renderPanel();
  }
}

// ---- 范围校验（本地、提交前；§3.2） --------------------------------------------

/** 疑似凭据（与设计 §5.4 同口径）：命中即拒绝提交，且不回显该值。 */
function looksLikeCredential(v: string): boolean {
  return /sk-/.test(v) || /Bearer\s/.test(v) || v.includes('\n') || v.length > 200;
}

const HOSTNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isIPv4(v: string): boolean {
  const [addr, bits] = v.split('/');
  if (bits !== undefined && !/^\d{1,2}$/.test(bits)) return false;
  if (bits !== undefined && Number(bits) > 32) return false;
  const parts = (addr ?? '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(v: string): boolean {
  const [addr, bits] = v.split('/');
  if (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > 128)) return false;
  if (!addr || !addr.includes(':')) return false;
  return /^[0-9a-fA-F:.]+$/.test(addr);
}

function isHostOrCidr(v: string): boolean {
  if (v.length > 253) return false;
  if (isIPv4(v) || isIPv6(v)) return true;
  return HOSTNAME_RE.test(v);
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function validateHosts(raw: string): { values: string[]; error: string } {
  const parts = splitList(raw);
  if (!parts.length) return { values: [], error: '请至少填写一个站点' };
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i]!;
    if (looksLikeCredential(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项疑似包含凭据，不能作为站点提交' };
    }
    if (!isHostOrCidr(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项不是有效的主机名、IP 或网段' };
    }
    out.push(v);
  }
  return { values: Array.from(new Set(out)), error: '' };
}

const TOOL_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

function validateTools(raw: string): { values: string[]; error: string } {
  const parts = splitList(raw);
  if (!parts.length) return { values: [], error: '请至少填写一个工具名' };
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i]!;
    if (looksLikeCredential(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项疑似包含凭据，不能提交' };
    }
    if (!TOOL_RE.test(v)) return { values: [], error: '第 ' + (i + 1) + ' 项不是有效的工具名' };
    out.push(v);
  }
  return { values: Array.from(new Set(out)), error: '' };
}

// ---- 范围哈希（必须与服务端逐字一致 —— 契约见设计 §6.4） ----------------------
//
// 服务端 source of truth：apps/studio/src/store/grants.ts 的 canonicalScopeJson，
// 形如 {"cap":"write_roots","scope":{"roots":["/a","/b"]}}；布尔类 cap
// （network/unsandboxed）为 {"cap":"network","scope":{}}。
//
// 曾经这里是 {"roots":[…]}（只放 scope 字段、不含 cap/scope 包裹），与服务端
// 哈希不同 ⇒ 令牌绑定的是前端哈希、POST 时服务端按自己的公式重算 ⇒ 每次授予都
// 会被判 403。两侧必须同步改：任何一侧动了这个形状，另一侧跟上。

function scopeKeyOf(cap: GrantCap): 'roots' | 'hosts' | 'tools' | null {
  if (cap === 'read_roots' || cap === 'write_roots') return 'roots';
  if (cap === 'net_hosts') return 'hosts';
  if (cap === 'tool_extra') return 'tools';
  return null;
}

function normList(v: readonly string[] | undefined): string[] {
  if (!v) return [];
  return Array.from(new Set(v.map((x) => x.trim()).filter((x) => x !== ''))).sort();
}

/** 规范序列化（与服务端 store/grants.ts:canonicalScopeJson 逐字一致，§6.4）。 */
export function canonicalScopeJson(cap: GrantCap, scope: GrantScope): string {
  const key = scopeKeyOf(cap);
  const inner: Record<string, string[]> = {};
  if (key !== null) {
    const raw = key === 'roots' ? scope.roots : key === 'hosts' ? scope.hosts : scope.tools;
    inner[key] = normList(raw);
  }
  return JSON.stringify({ cap, scope: inner });
}

async function scopeHashOf(cap: GrantCap, scope: GrantScope): Promise<string> {
  const text = canonicalScopeJson(cap, scope);
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return toHex(new Uint8Array(buf));
    } catch {
      /* 落到下方自带的实现（例如非安全上下文） */
    }
  }
  return toHex(sha256(bytes));
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * SHA-256（自带实现，仅在上面的浏览器能力不可用时使用）。
 * 为什么自带：页面可能经非安全来源访问，此时拿不到浏览器摘要能力，
 * 而范围哈希是令牌绑定的必要输入——缺失就等于无法授予权限。
 */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(blocks * 64 - 8, Math.floor(len / 536870912));
  view.setUint32(blocks * 64 - 4, (len * 8) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(b * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let bb = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + bb) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => dv.setUint32(i * 4, x));
  return out;
}

// ---- 装配 ----------------------------------------------------------------------

export function initGrants(): void {
  if (wired) return;
  wired = true;
  button = document.getElementById('slGrant') as HTMLButtonElement | null;
  badgeEl = document.getElementById('slGrantBadge');
  if (button) {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });
  }
  // 点击面板外 / 盾牌外 → 收起（与 statusline 的弹层行为一致）
  document.addEventListener('click', (e) => {
    if (!panel) return;
    const t = e.target as Node;
    if (panel.contains(t)) return;
    if (button && button.contains(t)) return;
    closePanel();
  });
  // 切换聚焦会话 → 换一份数据（盾牌与面板同步）
  onPaneChange(() => {
    inlineError.clear();
    panelNote = null;
    if (capability === 'on') void refresh(true);
  });
  // 回到页面时补一次（长时间后台期间可能已过期）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh(true);
  });
  void probeCapability(true);
  // 能力位可能随后续部署就绪：低频复探（不可用时不做任何其它请求）
  probeTimer = window.setInterval(() => {
    if (capability === 'off') void probeCapability(true);
  }, 60000);
}

/** 测试/自检用：当前能力位。 */
export function grantsCapability(): 'unknown' | 'on' | 'off' {
  return capability;
}

/** 测试用：清理定时器（页面卸载/自检）。 */
export function stopGrants(): void {
  stopPoll();
  if (probeTimer !== null) {
    window.clearInterval(probeTimer);
    probeTimer = null;
  }
}
