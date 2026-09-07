// ============================================================================
// ui/restore.ts — 启动时恢复主会话（cli-main）历史（方案A）：
//   GET /api/sessions/cli-main/messages → 用与 live 相同的渲染管线渲染最近
//   N=200 条存量（更早的加折叠提示）→ 尾部加「以下为本次会话」分隔线 →
//   之后的 SSE 增量照旧。衔接去重：SSE 重放的助手文本若与已恢复尾部同内容
//   （前缀匹配）则吞掉，直到发散；done 全量一致时丢弃重复气泡。
//   404/超时/端点缺失 → 保持空视图 + 轻提示，绝不崩溃。
// ============================================================================
import { api } from '../api';
import { S } from '../state';
import { el } from '../utils/dom';
import type { HistoryMsg } from '../types';
import {
  addUserMessage,
  autoscroll,
  ensureAssistant,
  finalizeAssistant,
} from './messages';

const MAX_RESTORE = 200;
const CLIENT_MAIN = 'cli-main';

// ---- 衔接去重状态 ------------------------------------------------------------

/** 已恢复尾部的最后一条（user/assistant；tool 不参与去重）。 */
let tail: HistoryMsg | null = null;

let guardActive = false;   // 正在对 live 助手增量做前缀匹配
let guardBuf = '';         // 已吞入的增量
let guardAll = false;      // 缓冲恰好等于完整 tail 内容（可能整体重放）

/** 重置去重状态（清空会话后调用）。 */
export function resetRestore(): void {
  tail = null;
  guardActive = false;
  guardBuf = '';
  guardAll = false;
}

/**
 * 处理一条 live 助手文本增量：若与已恢复尾部前缀匹配则吞掉（返回 null），
 * 发散后一次性吐出累积缓冲并解除守卫。
 */
export function feedAssistantDelta(delta: string): string | null {
  if (tail?.role !== 'assistant') {
    tail = null;
    return delta === '' ? null : delta;
  }
  if (!guardActive) {
    guardActive = true;
    guardBuf = '';
    guardAll = false;
  }
  guardBuf += delta;
  if (tail.content.startsWith(guardBuf)) {
    if (guardBuf === tail.content) guardAll = true;
    return null;
  }
  // 发散：吐出累积内容，退出守卫
  const out = guardBuf;
  guardActive = false;
  guardAll = false;
  tail = null;
  return out === '' ? null : out;
}

/**
 * done 事件钩子：若整条 live 助手消息是已恢复尾部的重放（无新增内容），
 * 返回 true 让调用方移除该重复气泡。
 */
export function finalAssistantDedup(text?: string): boolean {
  if (!guardActive) return false;
  guardActive = false;
  const drop =
    guardAll ||
    (typeof text === 'string' && text !== '' && tail?.role === 'assistant' && text === tail.content);
  guardAll = false;
  tail = null;
  return drop;
}

// ---- 渲染 ---------------------------------------------------------------------

function appendFoldNote(): void {
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  msgs.appendChild(
    el('div', 'restore-fold', '更早的历史已折叠 · 仅显示最近 ' + MAX_RESTORE + ' 条'),
  );
}

function appendLiveSeparator(): void {
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  const sep = el('div', 'live-sep');
  sep.appendChild(el('span', null, '以下为本次会话'));
  sep.title = '上方为刷新前恢复的存量消息';
  msgs.appendChild(sep);
}

function renderOne(m: HistoryMsg): void {
  const content = String(m.content);
  if (m.role === 'user') {
    addUserMessage(content);
    return;
  }
  if (m.role === 'assistant') {
    // 与 live 相同的 marked 渲染管线（ensureAssistant → finalizeAssistant 冲刷）
    const a = ensureAssistant();
    a.text = content;
    finalizeAssistant(a);
    S.assistant = null;
    return;
  }
  // tool：单色等宽块
  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '工具'));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content restore-tool');
  body.textContent = content;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  const msgs = document.getElementById('messages');
  if (msgs) msgs.appendChild(col);
}

/** 启动恢复：cli-main 最近 200 条 + 分隔线。失败 → 空视图 + 轻提示。 */
export async function restoreCliMainHistory(): Promise<void> {
  let resp;
  try {
    resp = await api.messages(CLIENT_MAIN);
  } catch (err) {
    // 404/超时/端点缺失：保持空视图，仅轻提示
    if (!S.streaming) {
      const msgs = document.getElementById('messages');
      if (msgs && !msgs.querySelector('.restore-note')) {
        msgs.appendChild(
          el('div', 'restore-note', '历史恢复暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）'),
        );
      }
    }
    return;
  }
  const all = resp.messages ?? [];
  if (S.streaming || !all.length) return; // 已开跑/空历史：不打断实时流
  const recent = all.length > MAX_RESTORE ? all.slice(all.length - MAX_RESTORE) : all;
  if (all.length > MAX_RESTORE) appendFoldNote();
  for (const m of recent) renderOne(m);
  appendLiveSeparator();
  autoscroll(true);
  tail = recent[recent.length - 1] ?? null;
}
