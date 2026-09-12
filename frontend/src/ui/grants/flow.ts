// ============================================================================
// ui/grants/flow.ts — 授予流程与撤销（设计 §3.3/§3.4/§5.5）
//   （W748 从 ui/grants.ts 拆出；纯搬运，确认句式/令牌重试/提示文案逐字未改。）
//
//   文案纪律（安全不变量，随代码一并搬家）：本模块所有面向用户的字符串都是
//   **固定常量**，绝不采用工具输出或模型文本中的任何字符串；范围值（路径/站点/
//   工具名）只作为**数据**填入固定句式。
// ============================================================================
import { api, ApiError, userErrorText } from '../../api';
import { scopeHashOf } from '../../security/scope-hash';
import type {
  EffectiveGrants,
  GrantCap,
  GrantEntry,
  GrantReq,
  GrantScope,
} from '../../types';
import { confirmDialog } from '../confirm';
import { pickDirectory } from '../fsbrowser';
import { flashStatus } from '../statusbar';
import { CAP_BY_NAME, hhmm, listOf, markFromEffective, nowSec, type CapDef } from './caps';
import { setMark } from './marks';
import { phraseFor, ttlOf } from './panel';
import { validateHosts, validateTools } from './scope';
import { drafts, getData, inlineError, setPanelNote, type GrantsHost } from './state';

// ---- 授予流程（令牌 + 二次确认 + 结果预览；§3.3/§3.4/§5.5） ----------------------

export async function startGrant(host: GrantsHost, def: CapDef): Promise<void> {
  const session = host.focusedSession();
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
      host.renderPanel();
      return;
    }
    scope = { hosts: v.values };
  } else if (def.kind === 'tools') {
    const v = validateTools(drafts.get(def.cap) ?? '');
    if (v.error !== '') {
      inlineError.set(def.cap, v.error);
      host.renderPanel();
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
    snapshot: JSON.stringify(getData()?.effective ?? {}, null, 2),
    snapshotLabel: '结果预览 · 生效快照（原样取自服务）',
    requireText: def.confirmWord,
    okLabel: '授予',
    danger: true,
  });
  if (!ok) return;

  const req: GrantReq = { cap: def.cap, scope, ttl_sec: ttl };
  if (def.cap === 'unsandboxed') req.uses_left = 1;

  setPanelNote({ text: '正在提交…', cls: 'busy' });
  host.renderPanel();
  try {
    const r = await submitGrant(session, def, req, scope);
    if (r === null) return;
    drafts.delete(def.cap);
    setPanelNote({ text: successText(def, r), cls: 'busy' });
    flashStatus(successText(def, r), 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await host.refresh(true);
  } catch (err) {
    const text = '放宽失败：' + userErrorText(err, '请稍后重试');
    setPanelNote({ text, cls: 'err' });
    flashStatus(text, 'err', 8000);
    host.renderPanel();
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

export async function revoke(host: GrantsHost, cap: GrantCap | null): Promise<void> {
  const session = host.focusedSession();
  if (session === '') return;
  const def = cap ? CAP_BY_NAME.get(cap) : undefined;
  setPanelNote({ text: '正在撤销…', cls: 'busy' });
  host.renderPanel();
  try {
    const r = await api.revokeCap(session, cap ? { cap } : {});
    const n = (r.revoked ?? []).length;
    const text = cap && def ? '已撤销：' + def.label : n > 1 ? '已撤销 ' + n + ' 项放宽权限' : '已撤销放宽权限';
    setPanelNote({ text, cls: 'busy' });
    flashStatus(text, 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await host.refresh(true);
  } catch (err) {
    const text = '撤销失败：' + userErrorText(err, '请稍后重试');
    setPanelNote({ text, cls: 'err' });
    flashStatus(text, 'err', 8000);
    host.renderPanel();
  }
}
