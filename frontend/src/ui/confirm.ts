// ============================================================================
// ui/confirm.ts — 破坏性操作二次确认弹窗（沿用 .modal-scrim/.modal-card 体系）：
//   默认焦点在「取消」；Esc / 点击遮罩 = 取消；确认后 resolve(true)。
//   第 26 轮（W256）：Esc 走 utils/overlays 层级栈（不再自建 document 监听，
//   避免与设置页/其他弹窗的监听重复触发，一次 Esc 只关栈顶一层）。
// ============================================================================
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';

export interface ConfirmOpts {
  title?: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
  focus?: 'ok' | 'cancel';
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = el('div', 'modal-scrim');
    const card = el('div', 'modal-card confirm-card');
    if (opts.title) card.appendChild(el('div', 'modal-card-title', opts.title));
    const msg = el('div', 'confirm-message');
    msg.textContent = opts.message;
    card.appendChild(msg);

    const actions = el('div', 'modal-card-actions');
    const ok = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-accent'), opts.okLabel ?? '确认') as HTMLButtonElement;
    ok.type = 'button';
    const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
    cancel.type = 'button';

    let done = false;
    let overlay: OverlayHandle | null = null;
    const settle = (v: boolean) => {
      if (done) return;
      done = true;
      if (overlay) {
        popOverlay(overlay);
        overlay = null;
      }
      scrim.remove();
      resolve(v);
    };

    ok.addEventListener('click', () => settle(true));
    cancel.addEventListener('click', () => settle(false));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) settle(false);
    });

    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    scrim.appendChild(card);
    document.body.appendChild(scrim);
    // 压栈：Esc 只关栈顶一层（确认框在设置页之上时先关它）
    overlay = pushOverlay(() => settle(false));
    // 默认焦点在「取消」
    (opts.focus === 'ok' ? ok : cancel).focus();
  });
}
