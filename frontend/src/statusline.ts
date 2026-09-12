// ============================================================================
// Statusline — 两行紧凑状态条，位于发送栏正上方（借鉴 DSH SessionStatusBar）：
//   第 1 行  上下文占用环(≥90% 警告色) + 「xxxK/1M」 + 当前模型 + 思考强度
//   第 2 行  tokens/s + 缓存命中率(W263) + step 数
// 数据源：GET /api/status 轮询（兜底）+ SSE status 事件增量字段
//   （SSE status 的 statusline 快照是嵌套对象，fromSse 里拍平后合并）。
// W227：模型/推理档位改为可点击按钮 → 紧凑下拉面板快速切换（POST /api/config），
//   409（轮次进行中）→ 提示并挂起，SSE done 后自动重试一次；400/500 → 内联报错。
// W726：上下文圆环可点击 → 打开只读「完整上下文」浮层（系统提示词/工具清单/
//   消息流）；能力位未就绪 → 只给一句轻提示，不报错、不打开浮层。
// ============================================================================
import { api, ApiError, userErrorText } from './api';
import { contextSupported, openContextView } from './ui/contextview'; // W726 只读上下文浮层
import { el, fmtCompact, need } from './utils/dom';
import { modelIconFor, type ModelIcon } from './utils/model-icon'; // W750 内置模型图标
import { popOverlay, pushOverlay, type OverlayHandle } from './utils/overlays';
import type {
  ConfigInfo,
  ConfigPatch,
  ModelInfo,
  StatusPayload,
  StatusSnapshot,
  UsageSnapshot,
} from './types';

const POLL_MS = 2000;
const RING_R = 5.2;
const RING_C = 2 * Math.PI * RING_R;
/** context ring turns warning color at/above this ratio */
const WARN_RATIO = 0.9;

/** W262：没有 provider 字段的模型（静态兜底目录 / 旧数据）归入的树状分组。 */
const OTHER_GROUP = '其他';

const EFFORT_OPTIONS: readonly { value: string | null; label: string }[] = [
  { value: null, label: '标准（清除）' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
];

type SwitchKind = 'model' | 'effort';

/**
 * W750：一次「切到 (provider, model)」。
 * `providerId` 非空 = 需要先切默认 provider（`provider_id` 是稳定 id，
 * 不是显示名）；空串 = 同一 provider 内换模型，直接改配置即可。
 */
interface ModelPick {
  model: string;
  providerId: string;
}

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
  /** W263: cache-hit-ratio cell (last stream + cumulative in the title). */
  private cacheEl: HTMLElement;
  private stepsEl: HTMLElement;
  private hintEl: HTMLElement;

  // ---- 快速切换（W227） ----
  /** W514: 当前聚焦会话 id（'' = 未解析/旧单会话）；轮询与快照按会话缓存。 */
  private session = '';
  private cache = new Map<string, StatusSnapshot>();
  private popup: HTMLElement | null = null;
  private popupKind: SwitchKind | null = null;
  /** 任务 3：弹层在全局层级栈中的句柄（Esc 只关栈顶一层）。 */
  private popupOverlay: OverlayHandle | null = null;
  private pendingPatch: ConfigPatch | null = null;
  /** W750：409 挂起的模型/提供商切换（SSE done 后按同一路径重试一次）。 */
  private pendingPick: ModelPick | null = null;
  /** W750：状态栏已渲染的模型名/图标键（避免每次轮询重建同一行）。 */
  private modelLabel = '';
  private modelIconKey: string | null = null;
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
    this.cacheEl = need<HTMLElement>('#slCache', this.el);
    this.stepsEl = need<HTMLElement>('#slSteps', this.el);
    this.hintEl = need<HTMLElement>('#slHint', this.el);
    this.ringProg.style.strokeDasharray = String(RING_C);
    this.el.title = '上下文占用 · 模型 · 思考强度 · 吞吐 · 缓存命中';

    // W726：点上下文圆环 → 只读完整上下文浮层
    this.ring.setAttribute('role', 'button');
    this.ring.setAttribute('tabindex', '0');
    this.ring.addEventListener('click', () => void this.openContext());
    this.ring.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this.openContext();
      }
    });
    // W227：模型/档位点击快速切换
    this.modelEl.addEventListener('click', () => this.togglePopup('model'));
    this.effortEl.addEventListener('click', () => this.togglePopup('effort'));
    // Esc 关闭统一由 utils/overlays 层级栈处理（任务 3：唯一 document Esc 监听）
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

  /**
   * W514：切换聚焦会话（chat.ts 在容器激活时调用）。
   * 立即显示该会话上次已知快照（缓存），并即时拉一次 /api/status?session=；
   * 模型/思考档位是全局配置，跨会话保留显示——切换不会闪成空白。
   */
  setSession(id: string): void {
    const next = id ?? '';
    if (this.session === next) return;
    this.session = next;
    const cached = this.cache.get(next);
    this.snapshot = {
      model: this.snapshot.model,
      reasoning_effort: this.snapshot.reasoning_effort,
      ...(cached ?? {}),
    };
    this.render();
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Merge incremental fields from an SSE status payload.
   * W263: the backend nests the snapshot ({"phase":..,"statusline":{..}}), so
   * the nested snapshot is flattened first; flat fields (older/newer shapes)
   * still win when present.
   */
  fromSse(p: StatusPayload): void {
    const flat = pickStatusFields({ ...(p.statusline ?? {}), ...p });
    if (Object.keys(flat).length > 0) {
      this.snapshot = { ...this.snapshot, ...flat };
      this.cache.set(this.session, this.snapshot);
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
    // W750：模型/提供商切换先走（它可能还要先切 provider）。
    const pick = this.pendingPick;
    if (pick !== null) {
      this.pendingPick = null;
      this.setNote('本轮已结束，正在应用切换…', 0);
      void this.runPick(pick).catch((err: unknown) => {
        this.setNote('切换失败：' + (err instanceof Error ? err.message : String(err)), 6000);
      });
      return;
    }
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

  // ---- 只读完整上下文（W726） -------------------------------------------------

  /**
   * 点上下文圆环：能力位就绪（capabilities.context === true）→ 打开只读浮层；
   * 未就绪 / 探测失败 → 只给一句用户语言的轻提示（不报错、不打开浮层）。
   * 会话 id 未解析（旧单会话容器）→ 同样只提示，不发无主请求。
   */
  private async openContext(): Promise<void> {
    if (!(await contextSupported())) {
      this.setNote('当前版本不支持查看上下文', 4000);
      return;
    }
    if (this.session === '') {
      this.setNote('当前会话尚未就绪，请稍后再试', 4000);
      return;
    }
    openContextView(this.session);
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
    if (this.popupOverlay) {
      popOverlay(this.popupOverlay);
      this.popupOverlay = null;
    }
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
    this.popupOverlay = pushOverlay(() => this.closePopup());

    popup.appendChild(el('div', 'sl-popup-title', kind === 'model' ? '切换模型' : '切换推理档位'));
    const body = el('div', 'sl-popup-body');
    popup.appendChild(body);
    body.appendChild(el('div', 'sl-popup-loading', '加载清单中…'));

    let cfg: ConfigInfo;
    try {
      cfg = await api.config();
    } catch (err) {
      if (this.popup !== popup) return;
      body.replaceChildren(
        el('div', 'sl-popup-error', userErrorText(err, '无法读取当前配置，请稍后重试')),
      );
      return;
    }
    if (this.popup !== popup) return; // 期间被关闭/切换

    // 铁律 1：整份清单先离屏构建，就绪后单次替换——「加载清单中…」保持可见到最后一刻。
    const off = document.createElement('div');

    if (kind === 'effort') {
      const options = [...EFFORT_OPTIONS];
      const cur = cfg.reasoning_effort ?? '';
      if (cur && !options.some((o) => o.value === cur)) {
        options.push({ value: cur, label: cur + '（当前）' });
      }
      for (const o of options) {
        off.appendChild(this.optButton(o.label, o.value ?? '', cur, () => this.apply({ reasoning_effort: o.value })));
      }
      body.replaceChildren(...off.childNodes);
      return;
    }

    // ---- model：按提供商分组的树状清单（W262） ----
    const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
    const cur = cfg.model ?? this.snapshot.model ?? '';
    if (!models.length) {
      // 清单缺失 → 内联文本输入降级
      const row = el('div', 'sl-popup-textrow');
      const input = el('input', 'sl-popup-input') as HTMLInputElement;
      input.placeholder = '模型名称';
      input.value = cur;
      row.appendChild(input);
      const applyBtn = el('button', 'btn btn-accent btn-mini', '应用') as HTMLButtonElement;
      applyBtn.addEventListener('click', () => {
        const v = input.value.trim();
        if (v !== '' && v !== cur) void this.apply({ model: v });
      });
      row.appendChild(applyBtn);
      off.appendChild(row);
      off.appendChild(el('div', 'sl-popup-note', '请输入模型名称'));
      body.replaceChildren(...off.childNodes);
      return;
    }
    const known = models.some((m) => m.id === cur);
    if (cur && !known) {
      // 当前模型不在清单里（自定义端点）→ 置顶一行，仍可点回
      off.appendChild(this.optButton(cur + '（当前）', cur, cur, () => void this.apply({ model: cur })));
      const sep = el('div', 'sl-popup-sep');
      sep.textContent = '候选模型';
      off.appendChild(sep);
    }
    // W750：当前生效项 = 后端标注的 active 行（同模型 + 同端点）。旧服务没有该
    // 字段时退回「按模型 id 匹配」；两者都没有 → 没有选中态，也不虚标。
    const activeRow = models.find((m) => m.active === true) ?? null;
    const sameId = models.find((m) => m.id === cur) ?? null;
    const currentProviderId = (activeRow?.provider_id ?? '').trim();
    const isCurrent = (m: ModelInfo): boolean =>
      activeRow !== null ? m.active === true : sameId !== null && m === sameId;
    // 树状一级 = provider 显示名（后端已保证模型名未定义时取 id）。
    // W750：同一 provider id 的记录聚成一组（显示名可能重复/被改，用 id 做键），
    // 缺 provider 字段的记录（静态兜底目录 / 旧数据）归入「其他」组。
    const groups: { pid: string; name: string; list: ModelInfo[] }[] = [];
    const byPid = new Map<string, { pid: string; name: string; list: ModelInfo[] }>();
    for (const m of models) {
      const pid = (m.provider_id ?? '').trim();
      const name = (m.provider ?? '').trim() || (pid !== '' ? pid : OTHER_GROUP);
      const key = pid !== '' ? pid : name;
      let group = byPid.get(key);
      if (!group) {
        group = { pid, name, list: [] };
        byPid.set(key, group);
        groups.push(group);
      }
      group.list.push(m);
    }
    for (const group of groups) {
      off.appendChild(this.groupRow(group.name, group.pid, group.list.some(isCurrent)));
      for (const m of group.list) {
        const pick: ModelPick = {
          model: m.id,
          // 显示名不是 id：只有拿到稳定 id 且与当前 provider 不同才需要先切 provider。
          providerId: (() => {
            const pid = (m.provider_id ?? '').trim();
            return pid !== '' && pid !== currentProviderId ? pid : '';
          })(),
        };
        off.appendChild(
          this.optButton(m.name || m.id, m.id, isCurrent(m) ? m.id : '', () => void this.pickModel(pick), true),
        );
      }
    }
    body.replaceChildren(...off.childNodes);
  }

  /**
   * W262：树状分组标题行 —— 提供商显示名，不可点击（无 button/无监听）。
   * W750：组内含当前生效项时标一个「当前」；display name 与稳定 id 不同名时
   * 把 id 一并淡显，免得两个 provider 显示名相似时看不出切的是哪一个。
   */
  private groupRow(provider: string, providerId: string, cur: boolean): HTMLElement {
    const row = el('div', 'sl-group' + (cur ? ' cur' : ''));
    row.appendChild(el('span', 'sl-group-name', provider));
    if (providerId !== '' && providerId !== provider) {
      row.appendChild(el('span', 'sl-group-id', providerId));
    }
    if (cur) row.appendChild(el('span', 'sl-group-tag', '当前'));
    return row;
  }

  /** 模型/档位一行；`sub=true` = 树状缩进一级（provider 组下的模型行）。 */
  private optButton(
    label: string,
    value: string,
    current: string,
    onPick: () => void,
    sub = false,
  ): HTMLElement {
    const cls =
      'sl-opt' +
      (sub ? ' sub' : '') +
      (value !== '' && value === current ? ' current' : '');
    const b = el('button', cls) as HTMLButtonElement;
    // W750：模型行前置家族图标（未识别 → 不加节点，不占位）。
    const icon = modelIconEl(value);
    if (icon !== null) b.appendChild(icon);
    b.appendChild(el('span', 'sl-opt-name', label));
    if (value !== '') b.appendChild(el('span', 'sl-opt-val', value));
    if (value !== '' && value === current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
    b.addEventListener('click', onPick);
    return b;
  }

  /**
   * W750：切到 (provider, model)。provider 不同 → 先 `POST /api/providers/default`
   * （带 provider_id 消歧：模型 id 跨 provider 会撞名），再 `POST /api/config {model}`；
   * 同一 provider → 只发后者（与旧行为逐字一致）。
   */
  private async pickModel(pick: ModelPick): Promise<void> {
    if (!this.popup) return;
    const popup = this.popup;
    const status = el('div', 'sl-popup-status busy', '切换中…');
    popup.appendChild(status);
    try {
      await this.runPick(pick);
      this.setNote('已切换', 5000);
      this.closePopup();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.pendingPick = pick;
        this.setNote('轮次进行中，将在本轮结束后生效', 0);
        this.closePopup();
      } else {
        const msg = '切换失败：' + (err instanceof Error ? err.message : String(err));
        if (this.popup === popup) {
          status.className = 'sl-popup-status err';
          status.textContent = msg;
        } else {
          this.setNote(msg, 6000);
        }
      }
    }
  }

  /** 切换的实际动作（先 provider 后模型）；任一步失败即抛出，不吞错。 */
  private async runPick(pick: ModelPick): Promise<void> {
    if (pick.providerId !== '') await api.setDefaultModel(pick.model, pick.providerId);
    const d = await api.saveConfig({ model: pick.model });
    this.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
    window.dispatchEvent(new Event('studio:config-saved'));
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

  private async poll(): Promise<void> {
    const asked = this.session;
    try {
      const s = await api.status(asked === '' ? undefined : asked);
      if (asked !== this.session) return; // 竞态：期间已切换会话，丢弃本次结果
      this.staleMsg = '';
      this.el.classList.remove('sl-stale');
      this.snapshot = { ...this.snapshot, ...s };
      this.cache.set(this.session, this.snapshot);
      this.render();
    } catch (err) {
      // /api/status 未上线或后端不可达：保持占位符，不打断聊天
      this.el.classList.add('sl-stale');
      this.staleMsg = '状态信息暂不可用';
      this.renderHint();
      this.el.title = userErrorText(err, '状态信息暂不可用');
    }
  }

  private render(): void {
    const s = this.snapshot;
    const usage = s.context_usage;
    if (usage && usage.window > 0) {
      const ratio = clamp01(usage.ratio);
      this.ctxEl.textContent = fmtCompact(usage.used) + '/' + fmtCompact(usage.window);
      this.ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
      this.ring.classList.toggle('warn', ratio >= WARN_RATIO);
      this.ring.title = '上下文占用 ' + Math.round(ratio * 1000) / 10 + '%' +
        ' · ' + fmtCompact(usage.used) + '/' + fmtCompact(usage.window) +
        '（点击查看完整上下文）';
    } else if (usage) {
      // W755：窗口未声明时不画假比率（对齐 DSH 缺容量即不显示环）。
      this.ctxEl.textContent = '占用未知';
      this.ring.style.strokeDashoffset = String(RING_C);
      this.ring.classList.remove('warn');
      this.ring.title = '上下文占用未知 · 点击查看完整上下文';
    } else {
      this.ctxEl.textContent = '—/—';
      this.ring.style.strokeDashoffset = String(RING_C);
      this.ring.classList.remove('warn');
      this.ring.title = '上下文占用（点击查看完整上下文）';
    }

    this.renderModel(s.model || '');
    this.modelEl.title = '当前模型：' + (s.model || '—') + '（点击快速切换）';

    // 思考强度：'max' 直接显示；空/null 表示标准档
    const effort = s.reasoning_effort;
    this.effortEl.textContent = effort ? String(effort) : '—';
    this.effortEl.title = '思考强度：' + (effort ? String(effort) : '标准') + '（点击快速切换）';

    const tps = s.tokens_per_sec;
    this.tpsEl.textContent = tps !== undefined && tps !== null ? fixed1(tps) + ' tok/s' : '— tok/s';

    // W263 缓存命中率：只改文本（铁律 1/2/5——不重建 DOM，不重渲染背景）
    this.renderCache(s.usage);

    const steps = s.steps;
    this.stepsEl.textContent = typeof steps === 'number' && steps >= 1 ? '第 ' + steps + ' 步' : '— 步';

    // W514：后端 busy 字段（多会话状态显示）——只切 class，不改布局
    this.el.classList.toggle('sl-live', s.busy === true);
  }

  /**
   * W750：状态栏的「图标 + 模型名」——同一行一起替换（单次 replaceChildren，
   * 不留空白帧）；名字与图标键都没变时一个字节都不动（轮询每 2 秒一次）。
   */
  private renderModel(name: string): void {
    const label = name || '—';
    const spec = modelIconFor(name);
    const key = spec === null ? null : spec.key;
    if (key === this.modelIconKey && label === this.modelLabel) return;
    this.modelIconKey = key;
    this.modelLabel = label;
    const kids: Node[] = [];
    if (spec !== null) kids.push(iconNode(spec));
    kids.push(document.createTextNode(label));
    this.modelEl.replaceChildren(...kids);
  }

  /**
   * W263: `缓存 78%` = the LATEST LLM stream's cache_read / prompt_tokens.
   * `缓存 —` when the engine has reported no usage yet. The title spells out
   * the exact numbers and the cumulative ratio (tracker.total()).
   */
  private renderCache(u: UsageSnapshot | undefined): void {
    if (!u || !(u.prompt_tokens > 0)) {
      this.cacheEl.textContent = '缓存 —';
      this.cacheEl.title = '暂无缓存命中数据';
      return;
    }
    const pct = Math.round(clamp01(u.cache_hit_ratio) * 100);
    this.cacheEl.textContent = '缓存 ' + pct + '%';
    const t = u.total;
    this.cacheEl.title =
      '最近一次请求：命中 ' +
      u.cache_read +
      ' / 输入 ' +
      u.prompt_tokens +
      ' tokens' +
      (t
        ? '（累计 ' + (clamp01(t.cache_hit_ratio) * 100).toFixed(1) + '%，命中 ' + t.cache_read + ' / 输入 ' + t.prompt_tokens + ' tokens）'
        : '');
  }
}

/**
 * W750：内置 SVG 源码 → 元素。源码是 model-icon.ts 里的常量字面量（无任何用户
 * 输入参与拼接），因此 innerHTML 在这里没有注入面；元素本身只做上色/定位。
 */
function iconNode(spec: ModelIcon): HTMLElement {
  const span = el('span', 'sl-micon sl-micon-' + spec.key);
  span.innerHTML = spec.svg;
  return span;
}

/** 模型 id → 图标元素；未识别返回 null（调用方跳过，不留空位）。 */
function modelIconEl(modelId: string): HTMLElement | null {
  const spec = modelIconFor(modelId);
  return spec === null ? null : iconNode(spec);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function fixed1(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

/** W514：状态字段筛选（statusline 渲染 + chat.ts 的每会话快照共用）。 */
export function pickStatusFields(p: StatusSnapshot): StatusSnapshot {
  const out: StatusSnapshot = {};
  if (p.model !== undefined) out.model = p.model;
  if (p.reasoning_effort !== undefined) out.reasoning_effort = p.reasoning_effort;
  if (p.steps !== undefined) out.steps = p.steps;
  if (p.tokens_per_sec !== undefined) out.tokens_per_sec = p.tokens_per_sec;
  if (p.context_usage !== undefined) out.context_usage = p.context_usage;
  if (p.usage !== undefined) out.usage = p.usage; // W263 缓存命中率
  if (p.busy !== undefined) out.busy = p.busy; // W514 运行态
  return out;
}

/**
 * W514：模块级单例——statusline 是「当前聚焦会话」的 chrome，chat.ts 需要在
 * 会话切换时调用 setSession()，因此由模块持有唯一实例（main.ts 只负责 start）。
 */
export const statusline = new Statusline();
