// ============================================================================
// ui/history.ts — 历史会话只读回放（单一职责）：
//   点击会话树叶子 → GET /api/sessions/{id}/messages 渲染进主聊天区；
//   顶部横幅「历史会话：<id>（只读）」+「回到主会话」按钮（重载 cli-main
//   历史并恢复输入）。messages 404 → 树仍可浏览，点击提示「历史加载暂不可用」。
// ============================================================================
import { api, ApiError } from '../api';
import { S } from '../state';
import { el } from '../utils/dom';
import type { HistoryMsg } from '../types';
import { highlightCode } from '../utils/hljs';
import { autoscroll, md, resetMessages } from './messages';
import { setReadOnly } from './inputbar';

const MsgsEl = document.getElementById('messages');
let banner: HTMLElement | null = null;

function ensureBanner(): HTMLElement {
  if (banner) return banner;
  banner = el('div', 'hist-banner');
  const label = el('span', 'hist-banner-label');
  const back = el('button', 'btn btn-soft hist-back', '回到主会话') as HTMLButtonElement;
  back.title = '退出只读回放：重新载入主会话（cli-main）历史并恢复输入';
  back.addEventListener('click', () => {
    void backToMain();
  });
  banner.appendChild(label);
  banner.appendChild(back);
  return banner;
}

function removeBanner(): void {
  if (banner) {
    banner.remove();
    banner = null;
  }
}

/** 渲染历史消息数组（只读）：user/assistant 气泡 + tool 单色块。 */
function renderHistoryMessages(msgs: HistoryMsg[]): void {
  if (!MsgsEl) return;
  MsgsEl.innerHTML = '';
  if (S.history && banner) MsgsEl.appendChild(banner);
  if (!msgs.length) {
    MsgsEl.appendChild(el('div', 'hist-note', '该会话暂无消息记录'));
    autoscroll(true);
    return;
  }
  for (const m of msgs) {
    const col = el('div', 'mcol');
    const msg = el('div', 'msg ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool'));
    const cap = el('div', 'msg-caption');
    cap.appendChild(el('span', 'who', m.role === 'user' ? '你' : m.role === 'assistant' ? 'Studio' : '工具'));
    msg.appendChild(cap);
    const bubble = el('div', 'bubble');
    const content = el('div', 'content');
    if (m.role === 'assistant') {
      content.innerHTML = md(String(m.content));
      highlightCode(content);
    } else if (m.role === 'tool') {
      content.classList.add('hist-tool');
      content.textContent = String(m.content);
    } else {
      content.textContent = String(m.content);
      content.style.whiteSpace = 'pre-wrap';
    }
    bubble.appendChild(content);
    msg.appendChild(bubble);
    col.appendChild(msg);
    MsgsEl.appendChild(col);
  }
  autoscroll(true);
}

/** 进入指定会话的只读回放。 */
export function enterHistory(id: string, title: string): void {
  if (!MsgsEl) return;
  if (S.streaming) {
    const foot = document.getElementById('sideFoot');
    if (foot) foot.textContent = '轮次进行中，暂不能切换历史视图';
    return;
  }
  S.history = { id, title };
  const b = ensureBanner();
  b.querySelector('.hist-banner-label')!.textContent = '历史会话：' + id + '（只读）';
  setReadOnly(true);
  MsgsEl.innerHTML = '';
  MsgsEl.appendChild(b);
  MsgsEl.appendChild(el('div', 'hist-note', '加载中…'));

  void api
    .messages(id)
    .then((d) => {
      if (S.history?.id !== id) return; // 期间已切走
      renderHistoryMessages(d.messages ?? []);
    })
    .catch((err: unknown) => {
      if (S.history?.id !== id) return; // 期间已切走
      MsgsEl.innerHTML = '';
      MsgsEl.appendChild(ensureBanner());
      const why = err instanceof ApiError && err.status === 404
        ? '历史加载暂不可用（HTTP 404：会话未知或历史端点未开放）'
        : '历史加载失败：' + (err instanceof Error ? err.message : String(err));
      MsgsEl.appendChild(el('div', 'hist-note err', why));
      autoscroll(true);
    });
}

/** 回到主会话：重载 cli-main 历史并恢复输入（缺失时回退为空实时视图）。 */
export async function backToMain(): Promise<void> {
  if (!MsgsEl) return;
  S.history = null;
  removeBanner();
  setReadOnly(false);
  try {
    const d = await api.messages('cli-main');
    if (S.history) return; // 等待期间又进入了历史视图
    renderHistoryMessages(d.messages ?? []);
  } catch {
    if (S.history) return;
    // cli-main 历史不可用：回到干净的实时视图（输入已恢复）
    resetMessages();
  }
}

/** 实时 turn 开始钩子（chat.ts 调用）：历史视图让位给实时流。 */
export function onLiveTurnStart(): void {
  if (!S.history) return;
  S.history = null;
  removeBanner();
  setReadOnly(false);
  resetMessages();
}
