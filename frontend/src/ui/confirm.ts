// ============================================================================
// ui/confirm.ts — 破坏性操作二次确认弹窗（沿用 .modal-scrim/.modal-card 体系）：
//   默认焦点在「取消」；Esc / 点击遮罩 = 取消；确认后 resolve(true)。
// ============================================================================
import { el } from '../utils/dom';

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
    const settle = (v: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    };

    ok.addEventListener('click', () => settle(true));
    cancel.addEventListener('click', () => settle(false));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) settle(false);
    });
    document.addEventListener('keydown', onKey);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    scrim.appendChild(card);
    document.body.appendChild(scrim);
    // 默认焦点在「取消」
    (opts.focus === 'ok' ? ok : cancel).focus();
  });
}
