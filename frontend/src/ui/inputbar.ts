// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 发送、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
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

/** 发送成功后清空输入框并复位高度。 */
export function clearInput(): void {
  const input = need<HTMLTextAreaElement>('#input');
  input.value = '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/** 切换 发送/取消 按钮状态。 */
export function setBusy(busy: boolean): void {
  if (sendBtn) sendBtn.disabled = busy;
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
}
