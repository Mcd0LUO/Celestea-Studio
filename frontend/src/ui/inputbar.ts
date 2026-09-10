// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 发送、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
//
// W514 多会话 / 插话契约：
//   - 运行中**不再禁用发送**：Enter/发送 = 插话（POST /api/turn 带 session，
//     注入该轮，不新开轮）；输入栏进入 interject 模式（浅色提示 + 按钮文案
//     「插话」），与空闲态有明确区分；
//   - readonly 模式（worker 会话视图）：发送禁用，仅查看；
//   - 发送/取消/停止按钮的显隐真源仍是 setBusy（当前聚焦会话的运行态）。
// ============================================================================
import { need } from '../utils/dom';

export interface InputBarHandlers {
  /** 发送；text 为原始输入内容（trim/校验由调用方负责）。 */
  send(text: string): void;
  cancel(): void;
}

export type InputMode = 'idle' | 'interject' | 'readonly';

const MAX_HEIGHT = 240;
const PLACEHOLDER_IDLE = '输入消息，Enter 发送，Shift+Enter 换行';
const PLACEHOLDER_INTERJECT = '运行中 · Enter 发送插话（将在下一步送达该轮）';
const PLACEHOLDER_READONLY = 'Worker 会话 · 只读查看';

let bar: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;

export function initInputBar(h: InputBarHandlers): void {
  const input = need<HTMLTextAreaElement>('#input');
  inputEl = input;
  bar = need<HTMLElement>('#inputbar');
  sendBtn = need<HTMLButtonElement>('#btnSend');
  cancelBtn = need<HTMLButtonElement>('#btnCancel');
  // W302：statusline 上的「停止」方形按钮（与 #btnCancel 共用同一个取消回调）
  const stopEl = need<HTMLButtonElement>('#slStop');
  stopBtn = stopEl;

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  };

  sendBtn.addEventListener('click', () => h.send(input.value));
  cancelBtn.addEventListener('click', () => h.cancel());
  stopEl.addEventListener('click', () => {
    if (stopEl.disabled) return;
    stopEl.disabled = true;
    h.cancel();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      h.send(input.value);
    }
  });
  input.addEventListener('input', autoGrow);
  window.setTimeout(autoGrow, 0);
}

/** 发送成功后清空输入框并复位高度。 */
export function clearInput(): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/** 当前输入框内容（切换会话时保存草稿用）。 */
export function inputValue(): string {
  return inputEl ? inputEl.value : '';
}

/** 写回输入框内容（切换会话恢复草稿 / 插话失败还原）。 */
export function setInputValue(v: string): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = v;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/**
 * 切换 取消/停止 按钮状态（= 当前聚焦会话是否运行中）。
 * 注意 W514：**发送按钮不再随 busy 禁用**（运行中发送走插话路径）。
 * setBusy 可能在 initInputBar 之前被调用（模块加载期）——可空守卫，不抛异常。
 */
export function setBusy(busy: boolean): void {
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !busy);
    stopBtn.disabled = !busy;
  }
}

/** 输入栏模式（空闲 / 插话 / 只读）——只切 class 与文案，不重建 DOM。 */
export function setInputMode(mode: InputMode): void {
  const input = inputEl;
  if (bar) {
    bar.classList.toggle('interject', mode === 'interject');
    bar.classList.toggle('readonly', mode === 'readonly');
  }
  if (input) {
    input.placeholder =
      mode === 'readonly'
        ? PLACEHOLDER_READONLY
        : mode === 'interject'
          ? PLACEHOLDER_INTERJECT
          : PLACEHOLDER_IDLE;
    input.readOnly = false; // 只读视图仍允许打字（草稿保留），发送被禁用
  }
  if (sendBtn) {
    sendBtn.disabled = mode === 'readonly';
    sendBtn.textContent = mode === 'readonly' ? '只读' : mode === 'interject' ? '插话' : '发送';
    sendBtn.title =
      mode === 'readonly'
        ? 'Worker 会话为只读视图'
        : mode === 'interject'
          ? '插话：注入当前运行中的轮次（不新开轮）'
          : '发送（Enter）';
  }
}
