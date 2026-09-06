// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 发送、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
// W227：新增 setReadOnly（历史只读回放时禁用输入，恢复主会话时解除）。
// ============================================================================
import { need } from '../utils/dom';

export interface InputBarHandlers {
  /** 发送；text 为原始输入内容（trim/校验由调用方负责）。 */
  send(text: string): void;
  cancel(): void;
}

const MAX_HEIGHT = 240;

let sendBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let readOnly = false;

export function initInputBar(h: InputBarHandlers): void {
  const input = need<HTMLTextAreaElement>('#input');
  sendBtn = need<HTMLButtonElement>('#btnSend');
  cancelBtn = need<HTMLButtonElement>('#btnCancel');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  };

  sendBtn.addEventListener('click', () => h.send(input.value));
  cancelBtn.addEventListener('click', () => h.cancel());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      h.send(input.value);
    }
  });
  input.addEventListener('input', autoGrow);
  window.setTimeout(autoGrow, 0);
}

/** 历史只读回放：禁用输入与发送（取消按钮仍可用）。 */
export function setReadOnly(on: boolean): void {
  readOnly = on;
  const input = need<HTMLTextAreaElement>('#input');
  input.disabled = on;
  input.placeholder = on
    ? '只读回放模式 · 点击左上横幅「回到主会话」恢复输入'
    : '输入消息，Enter 发送，Shift+Enter 换行';
  if (sendBtn) sendBtn.disabled = on;
}

/** 发送成功后清空输入框并复位高度。 */
export function clearInput(): void {
  const input = need<HTMLTextAreaElement>('#input');
  input.value = '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/** 切换 发送/取消 按钮状态（发送按钮同时受只读态约束）。 */
export function setBusy(busy: boolean): void {
  if (sendBtn) sendBtn.disabled = busy || readOnly;
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
}
