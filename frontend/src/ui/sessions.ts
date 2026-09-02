// ============================================================================
// 左侧「会话」面板：会话清单加载/渲染 + 清空当前会话。
// ============================================================================
import { api } from '../api';
import { $, el, need, $$ } from '../utils/dom';
import type { SessionInfo } from '../types';
import { S } from '../state';
import { resetMessages } from './messages';

const listEl = need<HTMLElement>('#sessionList');
const countEl = need<HTMLElement>('#sessionCount');

function renderSessions(sessions: SessionInfo[] | undefined): void {
  const arr = sessions ?? [];
  countEl.textContent = String(arr.length);
  listEl.innerHTML = '';
  if (!arr.length) {
    listEl.appendChild(el('div', 'side-note', '无会话记录'));
    return;
  }
  for (const s of arr) {
    const id = s.id ?? '';
    const live = s.live === true || s.kind === 'host';
    const item = el('div', 'sess-item' + (S.selSession === id ? ' active' : ''));
    item.dataset.id = id;
    const title = el('div', 'sess-title');
    title.appendChild(el('span', live ? 'sess-live' : 'sess-idle'));
    title.appendChild(el('span', null, s.title || '(未命名)'));
    item.appendChild(title);
    const meta = el('div', 'sess-meta');
    const bits: string[] = [];
    if (s.kind) bits.push(s.kind);
    if (s.workspace) bits.push(s.workspace);
    if (s.events !== undefined) bits.push('ev:' + s.events);
    bits.push(id);
    meta.textContent = bits.join(' · ');
    item.title = meta.textContent;
    item.appendChild(meta);
    item.addEventListener('click', () => {
      S.selSession = id;
      for (const n of $$<HTMLElement>('.sess-item', listEl)) {
        n.classList.toggle('active', n.dataset.id === id);
      }
      const foot = $('#sideFoot');
      if (foot) foot.textContent = '当前会话：' + (s.title || id || '—');
    });
    listEl.appendChild(item);
  }
}

export function loadSessions(): Promise<void> {
  listEl.innerHTML = '<div class="side-note">加载中…</div>';
  return api
    .sessions()
    .then((d) => {
      S.sessions = d.sessions ?? [];
      renderSessions(S.sessions);
    })
    .catch((err: unknown) => {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'side-note err', '会话接口不可用'));
      listEl.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    });
}

export function initSessionsPanel(): void {
  need<HTMLButtonElement>('#btnClearSess').addEventListener('click', () => {
    if (!window.confirm('确认清空当前会话？')) return;
    void api
      .clear()
      .then((d) => {
        const foot = $('#sideFoot');
        if (d.ok) {
          if (foot) foot.textContent = '会话已清空';
          resetMessages();
          S.assistant = null;
          S.turn = null;
        } else if (foot) {
          foot.textContent = '清空失败（返回异常）';
        }
      })
      .catch((err: unknown) => {
        const foot = $('#sideFoot');
        if (foot) foot.textContent = '清空失败：' + (err instanceof Error ? err.message : String(err));
      });
  });
  void loadSessions();
}
