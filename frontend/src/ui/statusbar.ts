// ============================================================================
// ui/statusbar.ts — 底部状态栏（单一职责）：连接/阶段文本、turn/step、耗时计时。
// 不感知 turn 生命周期——由 chat.ts 在合适时机调用本模块。
// ============================================================================
import { S } from '../state';
import { fmtTime, need } from '../utils/dom';

const StatusText = need<HTMLElement>('#statusText');
const StatusDot = need<HTMLElement>('#statusDot');
const StatusTurn = need<HTMLElement>('#statusTurn');
const StatusStep = need<HTMLElement>('#statusStep');
const StatusTime = need<HTMLElement>('#statusTime');

export function setStatus(text: string, cls?: string): void {
  StatusText.textContent = text;
  StatusDot.className = 'dot' + (cls ? ' ' + cls : '');
}

export function setStatusTurn(n: number | null): void {
  StatusTurn.textContent = typeof n === 'number' && n >= 1 ? 'turn ' + n : 'turn —';
}

export function setStatusStep(n: number | string | null): void {
  StatusStep.textContent = 'step ' + (n && String(n) !== '' ? String(n) : '—');
}

function tickTimer(): void {
  if (!S.streaming) return;
  StatusTime.textContent = fmtTime((Date.now() - S.t0) / 1000);
}

/** 启动（或重置）耗时计时：t0 取当前时刻。 */
export function startElapsedTimer(): void {
  S.t0 = Date.now();
  stopElapsedTimer();
  S.msgTimer = window.setInterval(tickTimer, 500);
  tickTimer();
}

export function stopElapsedTimer(): void {
  if (S.msgTimer !== null) {
    window.clearInterval(S.msgTimer);
    S.msgTimer = null;
  }
}
