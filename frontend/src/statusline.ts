// ============================================================================
// Statusline — 两行紧凑状态条，位于发送栏正上方（借鉴 DSH SessionStatusBar）：
//   第 1 行  上下文占用环(≥90% 警告色) + 「xxxK/1M」 + 当前模型 + 思考强度
//   第 2 行  tokens/s + step 数
// 数据源：GET /api/status 轮询（兜底）+ SSE status 事件增量字段。
// ============================================================================
import { api } from './api';
import { fmtCompact, need } from './utils/dom';
import type { StatusPayload, StatusSnapshot } from './types';

const POLL_MS = 2000;
const RING_R = 5.2;
const RING_C = 2 * Math.PI * RING_R;
/** context ring turns warning color at/above this ratio */
const WARN_RATIO = 0.9;

export class Statusline {
  private snapshot: StatusSnapshot = {};
  private timer: number | null = null;
  private el: HTMLElement;
  private ring: HTMLElement;
  private ringProg: SVGCircleElement;
  private ctxEl: HTMLElement;
  private modelEl: HTMLElement;
  private effortEl: HTMLElement;
  private tpsEl: HTMLElement;
  private stepsEl: HTMLElement;
  private hintEl: HTMLElement;

  constructor() {
    this.el = need<HTMLElement>('#statusline');
    this.ring = need<HTMLElement>('.sl-ring', this.el);
    this.ringProg = need<SVGCircleElement>('.sl-ring-prog', this.el);
    this.ctxEl = need<HTMLElement>('#slCtx', this.el);
    this.modelEl = need<HTMLElement>('#slModel', this.el);
    this.effortEl = need<HTMLElement>('#slEffort', this.el);
    this.tpsEl = need<HTMLElement>('#slTps', this.el);
    this.stepsEl = need<HTMLElement>('#slSteps', this.el);
    this.hintEl = need<HTMLElement>('#slHint', this.el);
    this.ringProg.style.strokeDasharray = String(RING_C);
    this.el.title = '上下文占用 · 模型 · 思考强度 · 吞吐（GET /api/status + SSE 增量）';
  }

  /** Begin polling /api/status. */
  start(): void {
    this.poll();
    this.timer = window.setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Merge incremental fields from an SSE status payload. */
  fromSse(p: StatusPayload): void {
    if (this.hasStatusFields(p)) {
      this.snapshot = { ...this.snapshot, ...pickStatusFields(p) };
      this.render();
    }
  }

  /** Merge any partial snapshot (e.g. health model). */
  merge(partial: StatusSnapshot): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.render();
  }

  private hasStatusFields(p: StatusPayload): boolean {
    return (
      p.model !== undefined ||
      p.reasoning_effort !== undefined ||
      p.steps !== undefined ||
      p.tokens_per_sec !== undefined ||
      p.context_usage !== undefined
    );
  }

  private async poll(): Promise<void> {
    try {
      const s = await api.status();
      this.hintEl.textContent = '';
      this.el.classList.remove('sl-stale');
      this.snapshot = { ...this.snapshot, ...s };
      this.render();
    } catch (err) {
      // /api/status 未上线或后端不可达：保持占位符，不打断聊天
      this.el.classList.add('sl-stale');
      this.hintEl.textContent = '状态接口暂不可用';
      const msg = err instanceof Error ? err.message : String(err);
      this.el.title = 'GET /api/status 失败：' + msg;
    }
  }

  private render(): void {
    const s = this.snapshot;
    const usage = s.context_usage;
    if (usage) {
      const ratio = clamp01(usage.ratio);
      this.ctxEl.textContent = fmtCompact(usage.used) + '/' + fmtCompact(usage.window);
      this.ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
      this.ring.classList.toggle('warn', ratio >= WARN_RATIO);
      this.ring.title = '上下文占用 ' + Math.round(ratio * 1000) / 10 + '%' +
        ' · ' + fmtCompact(usage.used) + '/' + fmtCompact(usage.window);
    } else {
      this.ctxEl.textContent = '—/—';
      this.ring.style.strokeDashoffset = String(RING_C);
      this.ring.classList.remove('warn');
    }

    this.modelEl.textContent = s.model || '—';
    this.modelEl.title = '当前模型：' + (s.model || '—');

    // 思考强度：'max' 直接显示；空/null 表示标准档
    const effort = s.reasoning_effort;
    this.effortEl.textContent = effort ? String(effort) : '—';
    this.effortEl.title = '思考强度：' + (effort ? String(effort) : '标准');

    const tps = s.tokens_per_sec;
    this.tpsEl.textContent = tps !== undefined && tps !== null ? fixed1(tps) + ' tok/s' : '— tok/s';

    const steps = s.steps;
    this.stepsEl.textContent = typeof steps === 'number' && steps >= 1 ? 'step ' + steps : 'step —';
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function fixed1(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

function pickStatusFields(p: StatusPayload): StatusSnapshot {
  const out: StatusSnapshot = {};
  if (p.model !== undefined) out.model = p.model;
  if (p.reasoning_effort !== undefined) out.reasoning_effort = p.reasoning_effort;
  if (p.steps !== undefined) out.steps = p.steps;
  if (p.tokens_per_sec !== undefined) out.tokens_per_sec = p.tokens_per_sec;
  if (p.context_usage !== undefined) out.context_usage = p.context_usage;
  return out;
}
