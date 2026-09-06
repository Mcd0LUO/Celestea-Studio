// ============================================================================
// Statusline — 两行紧凑状态条，位于发送栏正上方（借鉴 DSH SessionStatusBar）：
//   第 1 行  上下文占用环(≥90% 警告色) + 「xxxK/1M」 + 当前模型 + 思考强度
//   第 2 行  tokens/s + step 数
// 数据源：GET /api/status 轮询（兜底）+ SSE status 事件增量字段。
// W227：模型/推理档位改为可点击按钮 → 紧凑下拉面板快速切换（POST /api/config），
//   409（轮次进行中）→ 提示并挂起，SSE done 后自动重试一次；400/500 → 内联报错。
// ============================================================================
import { api, ApiError } from './api';
import { el, fmtCompact, need } from './utils/dom';
import type { ConfigInfo, ConfigPatch, StatusPayload, StatusSnapshot } from './types';

const POLL_MS = 2000;
const RING_R = 5.2;
const RING_C = 2 * Math.PI * RING_R;
/** context ring turns warning color at/above this ratio */
const WARN_RATIO = 0.9;

const EFFORT_OPTIONS: readonly { value: string | null; label: string }[] = [
  { value: null, label: '标准（清除）' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
];

type SwitchKind = 'model' | 'effort';

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

  // ---- 快速切换（W227） ----
  private popup: HTMLElement | null = null;
  private popupKind: SwitchKind | null = null;
  private pendingPatch: ConfigPatch | null = null;
  private staleMsg = '';
  private note = '';
  private noteTimer: number | null = null;

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

    // W227：模型/档位点击快速切换
    this.modelEl.addEventListener('click', () => this.togglePopup('model'));
    this.effortEl.addEventListener('click', () => this.togglePopup('effort'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePopup();
    });
    document.addEventListener('click', (e) => {
      if (!this.popup) return;
      const t = e.target as Node;
      if (this.popup.contains(t)) return;
      if (this.modelEl.contains(t) || this.effortEl.contains(t)) return;
      this.closePopup();
    });
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

  /** Merge any partial snapshot (e.g. health model / POST /api/config 响应). */
  merge(partial: StatusSnapshot): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.render();
  }

  /** SSE done 事件钩子：存在 409 挂起的快速切换补丁时自动重试一次。 */
  onSseDone(): void {
    if (!this.pendingPatch) return;
    const patch = this.pendingPatch;
    this.pendingPatch = null;
    this.setNote('本轮已结束，正在应用切换…', 0);
    void api
      .saveConfig(patch)
      .then((d) => {
        this.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
        this.setNote('已切换', 5000);
        window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        this.setNote('切换失败：' + (err instanceof Error ? err.message : String(err)), 6000);
      });
  }

  // ---- 快速切换面板 ---------------------------------------------------------

  private togglePopup(kind: SwitchKind): void {
    if (this.popup && this.popupKind === kind) {
      this.closePopup();
      return;
    }
    void this.openPopup(kind);
  }

  private closePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
      this.popupKind = null;
    }
  }

  private async openPopup(kind: SwitchKind): Promise<void> {
    this.closePopup();
    this.popupKind = kind;
    const popup = el('div', 'sl-popup');
    popup.setAttribute('role', 'menu');
    this.popup = popup;
    this.el.appendChild(popup);

    popup.appendChild(el('div', 'sl-popup-title', kind === 'model' ? '切换模型' : '切换推理档位'));
    const body = el('div', 'sl-popup-body');
    popup.appendChild(body);
    body.appendChild(el('div', 'sl-popup-loading', '加载清单中…'));

    let cfg: ConfigInfo;
    try {
      cfg = await api.config();
    } catch (err) {
      if (this.popup !== popup) return;
      body.innerHTML = '';
      body.appendChild(el('div', 'sl-popup-error', '无法读取 /api/config：' + (err instanceof Error ? err.message : String(err))));
      return;
    }
    if (this.popup !== popup) return; // 期间被关闭/切换
    body.innerHTML = '';

    if (kind === 'effort') {
      const options = [...EFFORT_OPTIONS];
      const cur = cfg.reasoning_effort ?? '';
      if (cur && !options.some((o) => o.value === cur)) {
        options.push({ value: cur, label: cur + '（当前）' });
      }
      for (const o of options) {
        body.appendChild(this.optButton(o.label, o.value ?? '', cur, () => this.apply({ reasoning_effort: o.value })));
      }
      return;
    }

    // ---- model ----
    const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
    const cur = cfg.model ?? this.snapshot.model ?? '';
    if (!models.length) {
      // 清单缺失 → 内联文本输入降级
      const row = el('div', 'sl-popup-textrow');
      const input = el('input', 'sl-popup-input') as HTMLInputElement;
      input.placeholder = '模型 id（后端未提供可选清单）';
      input.value = cur;
      row.appendChild(input);
      const applyBtn = el('button', 'btn btn-accent btn-mini', '应用') as HTMLButtonElement;
      applyBtn.addEventListener('click', () => {
        const v = input.value.trim();
        if (v !== '' && v !== cur) void this.apply({ model: v });
      });
      row.appendChild(applyBtn);
      body.appendChild(row);
      body.appendChild(el('div', 'sl-popup-note', '后端未返回 available.models，手动输入'));
      return;
    }
    const known = models.some((m) => m.id === cur);
    if (cur && !known) {
      body.appendChild(this.optButton(cur + '（当前）', cur, cur, () => this.apply({ model: cur })));
      const sep = el('div', 'sl-popup-sep');
      sep.textContent = '候选模型';
      body.appendChild(sep);
    }
    for (const m of models) {
      body.appendChild(this.optButton(m.name, m.id, cur, () => this.apply({ model: m.id })));
    }
  }

  private optButton(label: string, value: string, current: string, onPick: () => void): HTMLElement {
    const b = el('button', 'sl-opt' + (value !== '' && value === current ? ' current' : '')) as HTMLButtonElement;
    b.appendChild(el('span', 'sl-opt-name', label));
    if (value !== '') b.appendChild(el('span', 'sl-opt-val', value));
    if (value !== '' && value === current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
    b.addEventListener('click', onPick);
    return b;
  }

  /** POST /api/config 应用切换：成功→合并响应；409→挂起待 SSE done；其他→内联报错。 */
  private async apply(patch: ConfigPatch): Promise<void> {
    if (!this.popup) return;
    const popup = this.popup;
    const status = el('div', 'sl-popup-status busy', '切换中…');
    popup.appendChild(status);
    try {
      const d = await api.saveConfig(patch);
      this.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
      this.setNote('已切换', 5000);
      window.dispatchEvent(new Event('studio:config-saved'));
      this.closePopup();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.pendingPatch = patch;
        this.setNote('轮次进行中，将在本轮结束后生效', 0);
        this.closePopup();
      } else {
        if (this.popup === popup) {
          status.className = 'sl-popup-status err';
          status.textContent = '切换失败：' + (err instanceof Error ? err.message : String(err));
        } else {
          this.setNote('切换失败：' + (err instanceof Error ? err.message : String(err)), 6000);
        }
      }
    }
  }

  private setNote(text: string, ms: number): void {
    this.note = text;
    if (this.noteTimer !== null) {
      window.clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    if (ms > 0) {
      this.noteTimer = window.setTimeout(() => {
        this.note = '';
        this.noteTimer = null;
        this.renderHint();
      }, ms);
    }
    this.renderHint();
  }

  private renderHint(): void {
    if (this.note) {
      this.hintEl.textContent = this.note;
      return;
    }
    this.hintEl.textContent = this.staleMsg;
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
      this.staleMsg = '';
      this.el.classList.remove('sl-stale');
      this.snapshot = { ...this.snapshot, ...s };
      this.render();
    } catch (err) {
      // /api/status 未上线或后端不可达：保持占位符，不打断聊天
      this.el.classList.add('sl-stale');
      this.staleMsg = '状态接口暂不可用';
      this.renderHint();
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
    this.modelEl.title = '当前模型：' + (s.model || '—') + '（点击快速切换）';

    // 思考强度：'max' 直接显示；空/null 表示标准档
    const effort = s.reasoning_effort;
    this.effortEl.textContent = effort ? String(effort) : '—';
    this.effortEl.title = '思考强度：' + (effort ? String(effort) : '标准') + '（点击快速切换）';

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
