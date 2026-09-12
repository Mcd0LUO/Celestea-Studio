// ============================================================================
// ui/grants/caps.ts — 能力位定义与生效快照的纯读取（W748 从 ui/grants.ts 拆出）
//
//   只做搬家：文案、阈值、数据结构、判定语义与拆分前**逐字一致**。
//   本模块零 DOM、零网络：只有常量 + 纯函数（可在 node 里直接加载）。
// ============================================================================
import type { EffectiveGrants, GrantCap, GrantEntry, GrantScope } from '../../types';

/** 危险能力（侧栏红色小盾 + 二次确认 + 确认词，设计 §3.1/§3.3）。 */
export const DANGER_CAPS: ReadonlySet<string> = new Set(['network', 'write_roots', 'unsandboxed']);

/** 每项能力的用户语言定义（名称 / 一句话影响 / 表单形态；文案逐字取自设计 §3.2）。 */
export interface CapDef {
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

export const CAPS: readonly CapDef[] = [
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

export const CAP_BY_NAME = new Map<string, CapDef>(CAPS.map((c) => [c.cap, c]));

/** 有效期选项（秒 → 用户语言标签）。 */
export const TTL_CHOICES: readonly { sec: number; label: string }[] = [
  { sec: 900, label: '15 分钟' },
  { sec: 1800, label: '30 分钟' },
  { sec: 3600, label: '1 小时' },
  { sec: 86400, label: '24 小时' },
];
export interface GrantMark {
  /** 生效条数（已过期的不计，设计 §3.2）。 */
  count: number;
  /** 是否含危险能力（侧栏红盾）。 */
  danger: boolean;
  caps: string[];
}
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** unix 秒 → 本地 HH:MM（面板徽标与确认文案共用）。 */
export function hhmm(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 生效条数：已过期的不计入（§3.2 / §3.1）。 */
export function isExpired(g: GrantEntry): boolean {
  if (g.expired === true) return true;
  if (typeof g.expires_at === 'number' && g.expires_at > 0) return g.expires_at <= nowSec();
  return false;
}

export function scopeOf(g: GrantEntry | null): GrantScope {
  return g && g.scope && typeof g.scope === 'object' ? g.scope : {};
}

export function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 生效快照 → 侧栏标记（不含过期项）。 */
export function markFromEffective(eff: EffectiveGrants | undefined): GrantMark {
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
