// ============================================================================
// ui/grants/panel/phrase.ts — 能力 → 用户语言的固定句式 + 有效期取值（W760 拆出）。
//
//   纯函数（零 DOM）：结果预览（previewText）、逐项明细的短语（phraseFor）、
//   以及 TTL 的取值/上限（maxTtlOf / ttlOf）。flow.ts 的二次确认文案与授予请求
//   也直接用这里的 phraseFor / maxTtlOf / ttlOf，所以它们经 ../panel.ts 原样再导出。
//   W760 只搬家：句式、join 分隔符、TTL 收敛规则逐字未改。
// ============================================================================
import type { GrantScope } from '../../../types';
import { CAPS, listOf, scopeOf, type CapDef } from '../caps';
import { getData, ttlPick } from '../state';
import { activeFor, activeGrants } from './active';

/** 当前生效集 → 一句话预览（固定常量句式，范围值只作数据填入）。 */
export function previewText(): string {
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

/** 该能力的有效期上限（服务端 max_ttl_sec 优先；供面板与快捷授权共用）。 */
export function maxTtlOf(def: CapDef): number {
  const v = getData()?.max_ttl_sec?.[def.cap];
  return typeof v === 'number' && v > 0 ? v : def.maxTtl;
}

export function ttlOf(def: CapDef): number {
  const picked = ttlPick.get(def.cap);
  const max = maxTtlOf(def);
  const v = picked ?? Math.min(def.defaultTtl, max);
  return Math.min(v, max);
}
