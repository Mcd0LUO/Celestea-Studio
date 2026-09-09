// ============================================================================
// ui/providers.ts — 设置页「模型提供商」（W236 契约，端点缺失优雅降级）：
//   GET /api/providers 列表（名称/备注/请求格式/模型数/默认/has_key）
//   「添加提供商」→ 弹窗表单（名称/备注/API KEY/地址+请求测试/
//   请求格式/模型列表「获取模型」/单模型高级编辑）
//   第 26 轮（W256）：删除行内「编辑」按钮 —— 点击提供商行本体，在该行正下方
//   原地展开内联编辑面板（非弹窗）。面板 DOM 每个提供商行只构建一次，
//   展开/收起只切 class + max-height 过渡（铁律 4），禁止删除重建；
//   保存成功/取消后收起并局部刷新该行数据（不整表重建）。
//   POST /api/providers（upsert）· /test · /{id}/models/fetch · /{id}/delete
//   POST /api/providers/default（默认模型选择器，切换即热应用）
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { ProviderInfo, ProviderModelSpec } from '../types';
import { confirmDialog } from './confirm';

const boxEl = need<HTMLElement>('#settingsProviders');

let providers: ProviderInfo[] = [];
let defaultModel: string | null = null;
/** 已展开的内联面板（provider id）：列表刷新后恢复展开态（铁律 2）。 */
const openPanels = new Set<string>();

const FORMATS: readonly { value: string; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
];

/** 推理强度档位（W258 任务 3）：与后端 available.efforts 一致。 */
const EFFORT_TIERS: readonly string[] = ['low', 'high', 'max'];

/** 可点击多选档位片（toggle chips）：选中只切 class，不重建 DOM（铁律 4/8）。 */
interface EffortChips {
  root: HTMLElement;
  /** 回填选中态：未知档位（如历史数据里的 medium）自动补一片，保证往返不丢数据。 */
  set(values: readonly string[]): void;
  /** 当前选中档位（EFFORT_TIERS 顺序在前，非标准档位排后）。 */
  values(): string[];
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- 列表 ----------------------------------------------------------------------

function modelCount(p: ProviderInfo): number {
  return p.models?.length ?? 0;
}

/** 状态单元格内容（默认 / 已配 Key 徽章）：离屏构建后单次替换。 */
function renderStateCell(td: HTMLElement, p: ProviderInfo): void {
  const off = document.createElement('div');
  if (p.is_default) off.appendChild(el('span', 'prov-badge', '默认'));
  if (p.has_key) off.appendChild(el('span', 'prov-badge key', '已配 Key'));
  if (!p.is_default && !p.has_key) off.textContent = '—';
  td.replaceChildren(...off.childNodes);
}

/** 用最新数据就地刷新一行（不重建表格，不丢内联面板 DOM）。 */
function applyRowCells(tr: HTMLTableRowElement, p: ProviderInfo): void {
  const oldId = tr.dataset.id ?? '';
  tr.dataset.id = p.id;
  if (oldId !== p.id && openPanels.delete(oldId)) openPanels.add(p.id);
  tr.classList.toggle('is-default', p.is_default === true);
  const nameEl = tr.querySelector<HTMLElement>('.prov-name');
  if (nameEl) nameEl.textContent = p.name || p.id;
  const noteEl = tr.querySelector<HTMLElement>('.prov-td-note');
  if (noteEl) noteEl.textContent = p.note ?? '—';
  const fmtEl = tr.querySelector<HTMLElement>('.prov-td-fmt');
  if (fmtEl) fmtEl.textContent = p.request_format ?? '—';
  const modelsEl = tr.querySelector<HTMLElement>('.prov-td-models');
  if (modelsEl) modelsEl.textContent = String(modelCount(p));
  const stateEl = tr.querySelector<HTMLElement>('.prov-td-state');
  if (stateEl) renderStateCell(stateEl, p);
}

/** 保存成功后局部刷新该行数据（仅这一行，其余行与面板 DOM 不动）。 */
async function refreshRow(tr: HTMLTableRowElement, id: string): Promise<void> {
  try {
    const d = await api.providers();
    providers = d.providers ?? [];
    defaultModel = d.default_model ?? null;
    const p = providers.find((x) => x.id === id);
    if (!p) {
      void loadProviders(); // 改名/被删：整体双缓冲刷新兜底
      return;
    }
    applyRowCells(tr, p);
  } catch {
    void loadProviders(); // 局部刷新失败：双缓冲整体刷新兜底
  }
}

function renderProviders(container: HTMLElement): void {
  releasePanels(); // 旧行 DOM 即将被替换：先摘掉它们留在层级栈上的句柄
  container.replaceChildren();
  if (!providers.length) {
    container.appendChild(el('div', 'side-note', '暂无提供商 · 点击上方「添加提供商」创建'));
    return;
  }
  const table = el('table', 'prov-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['名称', '备注', '请求格式', '模型', '状态', '操作']) {
    hr.appendChild(el('th', null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const p of providers) {
    const row = renderProviderRow(p);
    tbody.appendChild(row.tr);
    tbody.appendChild(row.panelTr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderDefaultPicker(container: HTMLElement): void {
  const wrap = el('div', 'prov-default-card');
  const head = el('div', 'prov-default-head');
  head.appendChild(el('span', 'prov-default-title', '默认模型'));
  head.appendChild(el('span', 'prov-default-note', '切换即热应用（POST /api/providers/default）'));
  wrap.appendChild(head);
  const body = el('div', 'prov-default-body');
  body.appendChild(el('span', 'prov-default-label', '当前默认'));
  const sel = document.createElement('select');
  sel.className = 'cfg-input prov-default-sel';
  const known = new Set<string>();
  for (const p of providers) {
    for (const m of p.models ?? []) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = (p.name || p.id) + ' / ' + m.id;
      known.add(m.id);
      sel.appendChild(o);
    }
  }
  if (defaultModel !== null && !known.has(defaultModel)) {
    const o = document.createElement('option');
    o.value = defaultModel;
    o.textContent = defaultModel + '（当前默认，不在列表）';
    sel.appendChild(o);
  }
  sel.value = defaultModel ?? '';
  const msg = el('span', 'prov-default-msg');
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    msg.textContent = '应用默认模型…';
    msg.className = 'prov-default-msg';
    void api
      .setDefaultModel(v)
      .then(() => {
        defaultModel = v;
        msg.textContent = '已切换默认模型 · 热应用';
        msg.className = 'prov-default-msg ok';
        void loadProviders();
      })
      .catch((err: unknown) => {
        msg.textContent = '切换失败：' + fmtErr(err);
        msg.className = 'prov-default-msg err';
        sel.value = defaultModel ?? '';
      });
  });
  body.appendChild(sel);
  body.appendChild(msg);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

function setMsg(text: string, cls = ''): void {
  const m = boxEl.querySelector<HTMLElement>('.prov-list-msg');
  if (!m) return;
  m.textContent = text;
  m.className = 'prov-list-msg' + (cls ? ' ' + cls : '');
}

/** 载入并渲染提供商列表 + 默认模型卡片（增删改后调用）。
 *  第 11 轮：离屏构建 + 一次性替换（旧列表保留到新列表就绪，无「加载中…」空白帧）。 */
export async function loadProviders(): Promise<void> {
  const off = document.createElement('div');
  try {
    const d = await api.providers();
    providers = d.providers ?? [];
    defaultModel = d.default_model ?? null;
  } catch (err) {
    off.appendChild(el('div', 'side-note err', '提供商接口暂不可用'));
    off.appendChild(el('div', 'side-note', fmtErr(err)));
    boxEl.replaceChildren(...off.childNodes);
    return;
  }
  renderProviders(off);
  renderDefaultPicker(off);
  boxEl.replaceChildren(...off.childNodes);
}

// ---- 表单（弹窗「添加」与行内联「编辑」共用同一套构建逻辑） ------------------------

interface ModelRow {
  id: HTMLInputElement;
  name: HTMLInputElement;
  /** W258 任务 3：推理强度 = 可点击档位片（low/high/max，可多选） */
  efforts: EffortChips;
  ctx: HTMLInputElement;
  maxOut: HTMLInputElement;
  li: HTMLElement;
}

interface ProviderPayload {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: string;
  api_key?: string;
  models: ProviderModelSpec[];
}

interface EditorRefs {
  /** 表单根 DOM（字段 + 模型列表 + 操作行） */
  root: HTMLElement;
  name: HTMLInputElement;
  note: HTMLInputElement;
  key: HTMLInputElement;
  url: HTMLInputElement;
  format: HTMLSelectElement;
  modelsBox: HTMLElement;
  status: HTMLElement;
  rows: ModelRow[];
  /** 内容高度变化回调（内联面板用于重算 max-height） */
  onLayout?: (() => void) | undefined;
}

interface FormHooks {
  /** 保存成功（后端接受）→ 收起面板/关弹窗 + 刷新数据 */
  onSaved: (payload: ProviderPayload) => void;
  /** 取消 */
  onCancel: () => void;
  /** 内容高度变化（内联面板重算 max-height；弹窗忽略） */
  onLayout?: (() => void) | undefined;
}

function buildPayload(e: EditorRefs): ProviderPayload {
  const models: ProviderModelSpec[] = e.rows.map((r) => ({
    id: r.id.value.trim(),
    name: r.name.value.trim() || r.id.value.trim(),
    // W258 任务 3：档位片多选 → 数组（后端契约不变）
    reasoning_efforts: r.efforts.values(),
    context_window: numOrNull(r.ctx),
    max_output_tokens: numOrNull(r.maxOut),
  }));
  const key = e.key.value.trim();
  return {
    id: e.name.value.trim(),
    name: e.name.value.trim(),
    note: e.note.value.trim(),
    base_url: e.url.value.trim(),
    request_format: e.format.value,
    ...(key !== '' ? { api_key: key } : {}),
    models,
  };
}

function numOrNull(i: HTMLInputElement): number | null {
  const t = i.value.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function addModelRow(e: EditorRefs, id = '', name = ''): void {
  const li = el('div', 'prov-model-row');
  const rid = el('input', 'cfg-input') as HTMLInputElement;
  rid.placeholder = '模型 id';
  rid.value = id;
  const rname = el('input', 'cfg-input') as HTMLInputElement;
  rname.placeholder = '显示名';
  rname.value = name;
  const det = document.createElement('details');
  det.className = 'prov-model-adv';
  const sum = document.createElement('summary');
  sum.textContent = '高级（推理强度 / 上下文 / 最大输出）';
  det.appendChild(sum);
  const adv = el('div', 'prov-model-adv-body');
  // W258 任务 3：推理强度改为可点击档位片（多选）；点击只切 class + aria-pressed，
  // 不重建 DOM（铁律 4/8），点完通知内联面板重算 max-height。
  const selected = new Set<string>();
  const chipByValue = new Map<string, HTMLButtonElement>();
  const chipsRoot = el('div', 'prov-effort-chips');
  const addChip = (value: string): void => {
    const b = el('button', 'prov-effort-chip', value) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.effort = value;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      const on = selected.has(value);
      if (on) selected.delete(value);
      else selected.add(value);
      b.classList.toggle('on', !on);
      b.setAttribute('aria-pressed', on ? 'false' : 'true');
      e.onLayout?.();
    });
    chipByValue.set(value, b);
    chipsRoot.appendChild(b);
  };
  for (const tier of EFFORT_TIERS) addChip(tier);
  const chips: EffortChips = {
    root: chipsRoot,
    set(values: readonly string[]): void {
      const want = new Set(values.map((v) => v.trim()).filter(Boolean));
      for (const v of want) if (!chipByValue.has(v)) addChip(v); // 非标准档位补片保留
      selected.clear();
      for (const [v, b] of chipByValue) {
        const on = want.has(v);
        if (on) selected.add(v);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    },
    values(): string[] {
      const out: string[] = [];
      for (const t of EFFORT_TIERS) if (selected.has(t)) out.push(t);
      for (const v of selected) if (!EFFORT_TIERS.includes(v)) out.push(v);
      return out;
    },
  };
  const ctx = el('input', 'cfg-input') as HTMLInputElement;
  ctx.type = 'number';
  ctx.min = '0';
  ctx.placeholder = '上下文窗口（如 1000000）';
  const maxOut = el('input', 'cfg-input') as HTMLInputElement;
  maxOut.type = 'number';
  maxOut.min = '0';
  maxOut.placeholder = '最大输出 tokens';
  adv.appendChild(el('label', 'prov-adv-label', '推理强度'));
  adv.appendChild(chipsRoot);
  adv.appendChild(el('label', 'prov-adv-label', '模型上下文'));
  adv.appendChild(ctx);
  adv.appendChild(el('label', 'prov-adv-label', '最大输出 tokens'));
  adv.appendChild(maxOut);
  det.appendChild(adv);
  // 高级区展开/收起会改变内容高度：通知内联面板重算 max-height
  det.addEventListener('toggle', () => e.onLayout?.());
  const del = el('button', 'btn-mini danger', '移除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => {
    li.remove();
    e.rows = e.rows.filter((r) => r.li !== li);
    e.onLayout?.();
  });
  li.appendChild(rid);
  li.appendChild(rname);
  li.appendChild(det);
  li.appendChild(del);
  e.modelsBox.appendChild(li);
  e.rows.push({ id: rid, name: rname, efforts: chips, ctx, maxOut, li });
  e.onLayout?.();
}

/** 构建提供商表单 DOM（弹窗「添加」与行内联「编辑」复用；返回控件引用）。 */
function buildProviderForm(p: ProviderInfo | null, hooks: FormHooks): EditorRefs {
  const root = el('div', 'prov-form');

  const status = el('div', 'prov-editor-status');
  root.appendChild(status);

  const field = (label: string, ctrl: HTMLElement): HTMLElement => {
    const row = el('label', 'prov-field');
    row.appendChild(el('span', 'prov-field-label', label));
    row.appendChild(ctrl);
    return row;
  };

  const name = el('input', 'cfg-input') as HTMLInputElement;
  name.placeholder = '提供商 id（字母/数字/下划线）';
  name.value = p?.name ?? '';
  root.appendChild(field('名称', name));

  const note = el('input', 'cfg-input') as HTMLInputElement;
  note.placeholder = '备注（可选）';
  note.value = p?.note ?? '';
  root.appendChild(field('备注', note));

  const key = el('input', 'cfg-input') as HTMLInputElement;
  key.type = 'password';
  key.placeholder = p ? '留空 = 保持现有 Key' : 'API Key';
  key.value = '';
  root.appendChild(field('API Key', key));

  const url = el('input', 'cfg-input') as HTMLInputElement;
  url.placeholder = 'https://…/v1';
  url.value = p?.base_url ?? '';
  const testBtn = el('button', 'btn btn-soft btn-mini', '请求测试') as HTMLButtonElement;
  testBtn.type = 'button';
  const urlRow = el('div', 'prov-urlrow');
  urlRow.appendChild(url);
  urlRow.appendChild(testBtn);
  root.appendChild(field('API 请求地址', urlRow));

  const format = document.createElement('select');
  format.className = 'cfg-input';
  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f.value;
    o.textContent = f.label;
    format.appendChild(o);
  }
  if (p?.request_format) {
    const known = FORMATS.some((f) => f.value === p.request_format);
    if (!known) {
      const o = document.createElement('option');
      o.value = p.request_format;
      o.textContent = p.request_format;
      format.appendChild(o);
    }
    format.value = p.request_format;
  }
  root.appendChild(field('请求格式', format));

  // ---- 模型列表 ----
  const modelsHead = el('div', 'prov-models-head');
  modelsHead.appendChild(el('span', 'prov-models-title', '模型'));
  const fetchBtn = el('button', 'btn btn-soft btn-mini', '获取模型') as HTMLButtonElement;
  fetchBtn.type = 'button';
  fetchBtn.title = '据请求地址+Key 调用 models/fetch 快速填入（将先保存该提供商）';
  modelsHead.appendChild(fetchBtn);
  root.appendChild(modelsHead);
  const modelsBox = el('div', 'prov-models');
  root.appendChild(modelsBox);

  const e: EditorRefs = {
    root, name, note, key, url, format, modelsBox, status, rows: [], onLayout: hooks.onLayout,
  };

  for (const m of p?.models ?? []) {
    addModelRow(e, m.id, m.name);
    const r = e.rows[e.rows.length - 1]!;
    // W258 任务 3：已有模型的 reasoning_efforts 映射到对应档位片选中
    r.efforts.set(m.reasoning_efforts ?? []);
    if (m.context_window != null) r.ctx.value = String(m.context_window);
    // W258 任务 2：max_output_tokens（最大输出 tokens）不回填 —— 留空即可，
    // 留空保存即写 null（后端 numOrNull），这是期望行为。
  }

  const addM = el('button', 'btn-mini', '+ 添加模型') as HTMLButtonElement;
  addM.type = 'button';
  addM.addEventListener('click', () => addModelRow(e));
  root.appendChild(addM);

  // ---- 操作 ----
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const save = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  save.type = 'button';

  testBtn.addEventListener('click', () => {
    status.className = 'prov-editor-status';
    status.textContent = '测试中…';
    void api
      .testProvider(buildPayload(e))
      .then((r) => {
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = '测试失败：' + (r.error || '—');
          return;
        }
        status.className = 'prov-editor-status ok';
        status.textContent =
          '✓ 延迟 ' + (r.latency_ms ?? '—') + 'ms · 模型数 ' + (r.model_count ?? '—');
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = '测试失败：' + fmtErr(err);
      });
  });

  // 铁律 3：fetch 竞态守卫 —— 连点「获取模型」时，晚到的旧响应直接丢弃
  let fetchSeq = 0;
  fetchBtn.addEventListener('click', () => {
    const seq = ++fetchSeq;
    const id = name.value.trim();
    if (!id) {
      status.className = 'prov-editor-status err';
      status.textContent = '请先填写提供商名称（作为 id）';
      return;
    }
    status.className = 'prov-editor-status';
    status.textContent = '保存并获取模型中…';
    void api
      .saveProvider(buildPayload(e))
      .then(() => api.fetchProviderModels(id))
      .then((r) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃，不覆盖新状态
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = '获取失败：' + (r.error || '—');
          return;
        }
        // W258 任务 4：fetch 结果只缓存在局部变量（got），不自动写入表单
        const got = r.models ?? [];
        if (!got.length) {
          status.className = 'prov-editor-status';
          status.textContent = '上游未返回任何模型';
          return;
        }
        const existing = new Set(e.rows.map((x) => x.id.value.trim()).filter(Boolean));
        status.className = 'prov-editor-status ok';
        status.textContent = '已获取 ' + got.length + ' 个模型 · 请勾选要添加的模型';
        // 二级选择窗：确认后才 addModelRow（已存在的跳过不重复加）
        openModelPicker(
          got.map((m) => ({ id: m.id, existing: existing.has(m.id) })),
          (picked) => {
            const fresh = picked.filter((mid) => !e.rows.some((x) => x.id.value.trim() === mid));
            for (const mid of fresh) addModelRow(e, mid, mid);
            status.className = 'prov-editor-status ok';
            status.textContent = fresh.length
              ? '已添加 ' + fresh.length + ' 个模型（共获取 ' + got.length + ' 个）· 请保存以生效'
              : '未选择模型（共获取 ' + got.length + ' 个）· 请保存以生效';
          },
        );
      })
      .catch((err: unknown) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃
        status.className = 'prov-editor-status err';
        status.textContent = '获取模型失败：' + fmtErr(err);
      });
  });

  save.addEventListener('click', () => {
    const payload = buildPayload(e);
    if (!payload.id) {
      status.className = 'prov-editor-status err';
      status.textContent = '名称（id）不能为空';
      return;
    }
    status.className = 'prov-editor-status';
    status.textContent = '保存中…';
    save.disabled = true;
    void api
      .saveProvider(payload)
      .then((r) => {
        if (r.ok === false) {
          status.className = 'prov-editor-status err';
          status.textContent = '保存失败：' + (r.error || '后端拒绝');
          save.disabled = false;
          return;
        }
        save.disabled = false;
        status.className = 'prov-editor-status ok';
        status.textContent = '已保存';
        hooks.onSaved(payload);
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = '保存失败：' + fmtErr(err);
        save.disabled = false;
      });
  });

  cancel.addEventListener('click', () => hooks.onCancel());
  actions.appendChild(cancel);
  actions.appendChild(save);
  root.appendChild(actions);

  return e;
}

// ---- 「获取模型」二级选择窗（W258 任务 4） -------------------------------------------

interface PickerItem {
  id: string;
  /** 表单里已存在该模型：列出但不可勾选（避免重复添加） */
  existing: boolean;
}

/** 同一时刻只保留一个选择窗（重复点「获取模型」不叠窗）。 */
let closeModelPicker: (() => void) | null = null;

/** 二级选择窗：列出上游模型清单，勾选后点「确认」才写入表单。
 *  - 独立挂 body 的 modal（scrim/card），打开与关闭都不碰下方表单（铁律 5）；
 *  - 清单离屏构建 + 单次替换，一次挂载（铁律 1：无空白帧 / 无闪烁）；
 *  - pushOverlay(close)：Esc 先关本窗（层级栈栈顶），再关下层内联面板/弹窗。 */
function openModelPicker(items: readonly PickerItem[], onConfirm: (picked: string[]) => void): void {
  closeModelPicker?.(); // 单例：旧的（若有）先关
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prov-picker');
  card.appendChild(el('div', 'modal-card-title', '选择要添加的模型'));
  card.appendChild(
    el('div', 'side-note', '请勾选要添加的模型（默认不勾选；已存在的模型不可重复添加）'),
  );

  const list = el('div', 'prov-picker-list');
  const boxes: HTMLInputElement[] = [];
  const count = el('div', 'prov-picker-count');
  const syncCount = (): void => {
    const n = boxes.filter((b) => b.checked).length;
    count.textContent = '已选 ' + n + ' / ' + boxes.length + ' 个可选模型';
  };
  const off = document.createElement('div'); // 离屏构建：整份清单一次替换
  for (const it of items) {
    const row = el('label', 'prov-picker-row' + (it.existing ? ' existing' : ''));
    const cb = el('input', 'prov-picker-cb') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = false; // 默认全部不勾选
    cb.disabled = it.existing;
    cb.dataset.modelId = it.id;
    cb.addEventListener('change', syncCount);
    row.appendChild(cb);
    row.appendChild(el('span', 'prov-picker-id', it.id));
    if (it.existing) row.appendChild(el('span', 'prov-picker-tag', '已存在'));
    off.appendChild(row);
    if (!it.existing) boxes.push(cb);
  }
  list.replaceChildren(...off.childNodes);
  syncCount();
  card.appendChild(list);
  card.appendChild(count);

  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const ok = el('button', 'btn btn-accent', '确认') as HTMLButtonElement;
  ok.type = 'button';

  let overlay: OverlayHandle | null = null;
  const close = (): void => {
    if (closeModelPicker === close) closeModelPicker = null;
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  closeModelPicker = close;
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => {
    const picked = boxes
      .filter((b) => b.checked)
      .map((b) => b.dataset.modelId ?? '')
      .filter(Boolean);
    close();
    onConfirm(picked); // 先关窗再写表单：开关本身不触发背景重渲染
  });
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });

  actions.appendChild(cancel);
  actions.appendChild(ok);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  overlay = pushOverlay(close); // Esc：先关本选择窗（栈顶）
  cancel.focus();
}

// ---- 行内联编辑面板（任务 2） ------------------------------------------------------

interface PanelState {
  tr: HTMLTableRowElement;
  panelTr: HTMLTableRowElement;
  inner: HTMLElement;
  open: boolean;
  overlay: OverlayHandle | null;
}

/** 当前列表里存活的面板状态（列表整体刷新时用于释放其层级栈句柄）。 */
const livePanels = new Set<PanelState>();

/** 列表重建前调用：摘掉旧面板的层级栈句柄，避免 Esc 需要多按几次。 */
function releasePanels(): void {
  for (const st of livePanels) {
    if (st.overlay) {
      popOverlay(st.overlay);
      st.overlay = null;
    }
  }
  livePanels.clear();
}

/** 内容增高后重算 max-height（展开态若为 none 则无需处理）。 */
function syncPanelHeight(state: PanelState): void {
  if (!state.open) return;
  const h = state.inner.style.maxHeight;
  if (h === 'none' || h === '') return;
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
}

function expandPanel(state: PanelState): void {
  if (state.open) return;
  state.open = true;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.add(id);
  state.tr.classList.add('expanded');
  state.tr.setAttribute('aria-expanded', 'true');
  state.panelTr.classList.add('open');
  // 先量出内容高度再过渡（max-height 过渡，铁律 4：只切 class，不重建 DOM）
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
  state.overlay = pushOverlay(() => collapsePanel(state));
}

function collapsePanel(state: PanelState): void {
  if (!state.open) return;
  state.open = false;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.delete(id);
  if (state.overlay) {
    popOverlay(state.overlay);
    state.overlay = null;
  }
  // 展开完成时 maxHeight 已置 'none'：先固定当前高度并强制回流，再归零 → 收起动画生效
  if (state.inner.style.maxHeight === 'none') {
    state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
    void state.inner.offsetHeight;
  }
  state.panelTr.classList.remove('open');
  state.tr.classList.remove('expanded');
  state.tr.setAttribute('aria-expanded', 'false');
  state.inner.style.maxHeight = '0px';
}

function togglePanel(state: PanelState): void {
  if (state.open) collapsePanel(state);
  else expandPanel(state);
}

/** 构建一行提供商（数据行 + 正下方内联面板行）；面板 DOM 只构建一次。 */
function renderProviderRow(p: ProviderInfo): { tr: HTMLTableRowElement; panelTr: HTMLTableRowElement } {
  const tr = el('tr', 'prov-row') as HTMLTableRowElement;
  tr.dataset.id = p.id;
  tr.title = '点击展开/收起内联编辑';
  tr.setAttribute('aria-expanded', 'false');
  if (p.is_default) tr.classList.add('is-default');

  const tdName = el('td', 'prov-td-name');
  tdName.appendChild(el('span', 'prov-name', p.name || p.id));
  tr.appendChild(tdName);
  tr.appendChild(el('td', 'prov-td-note', p.note ?? '—'));
  tr.appendChild(el('td', 'prov-td-fmt', p.request_format ?? '—'));
  tr.appendChild(el('td', 'prov-td-models', String(modelCount(p))));
  const tdState = el('td', 'prov-td-state');
  renderStateCell(tdState, p);
  tr.appendChild(tdState);

  const tdOps = el('td', 'prov-td-ops');
  const del = el('button', 'btn-mini danger', '删除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // 删除不触发展开/收起
    const id = tr.dataset.id ?? '';
    const cur = providers.find((x) => x.id === id);
    void confirmDialog({
      title: '删除提供商',
      message: '确认删除提供商「' + (cur?.name || id) + '」？',
      okLabel: '删除',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void api
        .deleteProvider(id)
        .then(() => void loadProviders())
        .catch((err: unknown) => setMsg('删除失败：' + fmtErr(err)));
    });
  });
  tdOps.appendChild(del);
  tr.appendChild(tdOps);

  // ---- 内联面板行（该行正下方） ----
  const panelTr = el('tr', 'prov-panel-row') as HTMLTableRowElement;
  const td = el('td', 'prov-panel-td') as HTMLTableCellElement;
  td.colSpan = 6;
  const inner = el('div', 'prov-inline');
  td.appendChild(inner);
  panelTr.appendChild(td);

  const state: PanelState = { tr, panelTr, inner, open: false, overlay: null };
  livePanels.add(state);
  const refs = buildProviderForm(p, {
    onSaved: (payload) => {
      collapsePanel(state);
      void refreshRow(tr, payload.id);
    },
    onCancel: () => collapsePanel(state),
    onLayout: () => syncPanelHeight(state),
  });
  inner.appendChild(refs.root);

  // 展开完成 → 解除高度约束（内容随后增高不再被裁切）
  inner.addEventListener('transitionend', (e) => {
    if (e.target !== inner || e.propertyName !== 'max-height') return;
    if (state.open) inner.style.maxHeight = 'none';
  });

  // 点击行本体（非交互控件）→ 原地展开/收起
  tr.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('button, a, input, select, textarea, label')) return;
    togglePanel(state);
  });

  // 刷新后恢复展开态（无动画：直接落到位）
  if (openPanels.has(p.id)) {
    state.open = true;
    tr.classList.add('expanded');
    tr.setAttribute('aria-expanded', 'true');
    panelTr.classList.add('open');
    inner.style.maxHeight = 'none';
    state.overlay = pushOverlay(() => collapsePanel(state));
  }

  return { tr, panelTr };
}

// ---- 「添加提供商」弹窗（编辑走行内联面板） -----------------------------------------

let closeAddModal: (() => void) | null = null;

function openEditor(): void {
  closeAddModal?.(); // 同一时刻只保留一个「添加提供商」弹窗

  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prov-modal');
  card.appendChild(el('div', 'modal-card-title', '添加提供商'));

  let overlay: OverlayHandle | null = null;
  const close = (): void => {
    if (closeAddModal === close) closeAddModal = null;
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  closeAddModal = close;

  const form = buildProviderForm(null, {
    onSaved: () => {
      close();
      void loadProviders();
    },
    onCancel: close,
  });
  card.appendChild(form.root);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  // 任务 3：挂到 body 的弹窗打开时 push 自身 close，Esc 只关栈顶一层
  overlay = pushOverlay(close);
  form.name.focus();
}

export function initProvidersSection(): void {
  need<HTMLButtonElement>('#btnAddProvider').addEventListener('click', () => openEditor());
}
