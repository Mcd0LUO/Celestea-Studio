// ============================================================================
// ui/providers.ts — 设置页「模型提供商」（W236 契约，端点缺失优雅降级）：
//   GET /api/providers 列表（名称/备注/请求格式/模型数/默认/has_key）
//   「添加提供商」/「编辑」→ 弹窗表单（名称/备注/API KEY/地址+请求测试/
//   请求格式/模型列表「获取模型」/单模型高级编辑）
//   POST /api/providers（upsert）· /test · /{id}/models/fetch · /{id}/delete
//   POST /api/providers/default（默认模型选择器，切换即热应用）
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { ProviderInfo, ProviderModelSpec } from '../types';

const boxEl = need<HTMLElement>('#settingsProviders');

let providers: ProviderInfo[] = [];
let defaultModel: string | null = null;

const FORMATS: readonly { value: string; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
];

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- 列表 ----------------------------------------------------------------------

function modelCount(p: ProviderInfo): number {
  return p.models?.length ?? 0;
}

function renderProviders(): void {
  boxEl.innerHTML = '';
  if (!providers.length) {
    boxEl.appendChild(el('div', 'side-note', '暂无提供商 · 点击上方「添加提供商」创建'));
    return;
  }
  for (const p of providers) {
    const row = el('div', 'prov-row' + (p.is_default ? ' is-default' : ''));
    const main = el('div', 'prov-main');
    const head = el('div', 'prov-title');
    head.appendChild(el('span', 'prov-name', p.name || p.id));
    if (p.is_default) head.appendChild(el('span', 'prov-badge', '默认'));
    if (p.has_key) head.appendChild(el('span', 'prov-badge key', '已配 Key'));
    if (p.note) head.appendChild(el('span', 'prov-note', String(p.note)));
    main.appendChild(head);
    const meta = el('div', 'prov-meta');
    const bits: string[] = [];
    if (p.request_format) bits.push('格式：' + p.request_format);
    bits.push('模型：' + modelCount(p));
    if (p.base_url) bits.push(p.base_url);
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);
    row.appendChild(main);
    const actions = el('div', 'prov-actions');
    const edit = el('button', 'btn-mini', '编辑') as HTMLButtonElement;
    edit.type = 'button';
    edit.addEventListener('click', () => openEditor(p.id));
    const del = el('button', 'btn-mini danger', '删除') as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!window.confirm('确认删除提供商「' + (p.name || p.id) + '」？')) return;
      void api
        .deleteProvider(p.id)
        .then(() => void loadProviders())
        .catch((err: unknown) => setMsg('删除失败：' + fmtErr(err)));
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    row.appendChild(actions);
    boxEl.appendChild(row);
  }
}

function renderDefaultPicker(): void {
  const wrap = el('div', 'prov-default');
  wrap.appendChild(el('span', 'prov-default-label', '默认模型：'));
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
  wrap.appendChild(sel);
  wrap.appendChild(msg);
  boxEl.appendChild(wrap);
}

function setMsg(text: string, cls = ''): void {
  const m = boxEl.querySelector<HTMLElement>('.prov-list-msg');
  if (!m) return;
  m.textContent = text;
  m.className = 'prov-list-msg' + (cls ? ' ' + cls : '');
}

export async function loadProviders(): Promise<void> {
  boxEl.innerHTML = '<div class="side-note">加载中…</div>';
  try {
    const d = await api.providers();
    providers = d.providers ?? [];
    defaultModel = d.default_model ?? null;
  } catch (err) {
    boxEl.innerHTML = '';
    boxEl.appendChild(el('div', 'side-note err', '提供商接口暂不可用'));
    boxEl.appendChild(el('div', 'side-note', fmtErr(err)));
    return;
  }
  renderProviders();
  renderDefaultPicker();
}

// ---- 编辑弹窗 ---------------------------------------------------------------------

interface ModelRow {
  id: HTMLInputElement;
  name: HTMLInputElement;
  efforts: HTMLInputElement;
  ctx: HTMLInputElement;
  maxOut: HTMLInputElement;
  li: HTMLElement;
}

interface EditorRefs {
  scrim: HTMLElement;
  card: HTMLElement;
  name: HTMLInputElement;
  note: HTMLInputElement;
  key: HTMLInputElement;
  url: HTMLInputElement;
  format: HTMLSelectElement;
  modelsBox: HTMLElement;
  status: HTMLElement;
  rows: ModelRow[];
}

let editor: EditorRefs | null = null;

function closeEditor(): void {
  editor?.scrim.remove();
  editor = null;
}

function buildPayload(e: EditorRefs): {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: string;
  api_key?: string;
  models: ProviderModelSpec[];
} {
  const models: ProviderModelSpec[] = e.rows.map((r) => ({
    id: r.id.value.trim(),
    name: r.name.value.trim() || r.id.value.trim(),
    reasoning_efforts: r.efforts.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
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
  const efforts = el('input', 'cfg-input') as HTMLInputElement;
  efforts.placeholder = '推理强度，逗号分隔（如 low,high,max）';
  const ctx = el('input', 'cfg-input') as HTMLInputElement;
  ctx.type = 'number';
  ctx.min = '0';
  ctx.placeholder = '上下文窗口（如 1000000）';
  const maxOut = el('input', 'cfg-input') as HTMLInputElement;
  maxOut.type = 'number';
  maxOut.min = '0';
  maxOut.placeholder = '最大输出 tokens';
  adv.appendChild(el('label', 'prov-adv-label', '推理强度'));
  adv.appendChild(efforts);
  adv.appendChild(el('label', 'prov-adv-label', '模型上下文'));
  adv.appendChild(ctx);
  adv.appendChild(el('label', 'prov-adv-label', '最大输出 tokens'));
  adv.appendChild(maxOut);
  det.appendChild(adv);
  const del = el('button', 'btn-mini danger', '移除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => {
    li.remove();
    e.rows = e.rows.filter((r) => r.li !== li);
  });
  li.appendChild(rid);
  li.appendChild(rname);
  li.appendChild(det);
  li.appendChild(del);
  e.modelsBox.appendChild(li);
  e.rows.push({ id: rid, name: rname, efforts, ctx, maxOut, li });
}

function openEditor(providerId: string | null): void {
  closeEditor();
  const p = providerId !== null ? providers.find((x) => x.id === providerId) ?? null : null;

  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prov-modal');
  card.appendChild(el('div', 'modal-card-title', p ? '编辑提供商：' + p.name : '添加提供商'));

  const status = el('div', 'prov-editor-status');
  card.appendChild(status);

  const field = (label: string, ctrl: HTMLElement) => {
    const row = el('label', 'prov-field');
    row.appendChild(el('span', 'prov-field-label', label));
    row.appendChild(ctrl);
    return row;
  };

  const name = el('input', 'cfg-input') as HTMLInputElement;
  name.placeholder = '提供商 id（字母/数字/下划线）';
  name.value = p?.name ?? '';
  card.appendChild(field('名称', name));

  const note = el('input', 'cfg-input') as HTMLInputElement;
  note.placeholder = '备注（可选）';
  note.value = p?.note ?? '';
  card.appendChild(field('备注', note));

  const key = el('input', 'cfg-input') as HTMLInputElement;
  key.type = 'password';
  key.placeholder = p ? '留空 = 保持现有 Key' : 'API Key';
  key.value = '';
  card.appendChild(field('API Key', key));

  const url = el('input', 'cfg-input') as HTMLInputElement;
  url.placeholder = 'https://…/v1';
  url.value = p?.base_url ?? '';
  const testBtn = el('button', 'btn btn-soft btn-mini', '请求测试') as HTMLButtonElement;
  testBtn.type = 'button';
  const urlRow = el('div', 'prov-urlrow');
  urlRow.appendChild(url);
  urlRow.appendChild(testBtn);
  card.appendChild(field('API 请求地址', urlRow));

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
  card.appendChild(field('请求格式', format));

  // ---- 模型列表 ----
  const modelsHead = el('div', 'prov-models-head');
  modelsHead.appendChild(el('span', 'prov-models-title', '模型'));
  const fetchBtn = el('button', 'btn btn-soft btn-mini', '获取模型') as HTMLButtonElement;
  fetchBtn.type = 'button';
  fetchBtn.title = '据请求地址+Key 调用 models/fetch 快速填入（将先保存该提供商）';
  modelsHead.appendChild(fetchBtn);
  card.appendChild(modelsHead);
  const modelsBox = el('div', 'prov-models');
  card.appendChild(modelsBox);

  const e: EditorRefs = {
    scrim, card, name, note, key, url, format, modelsBox, status, rows: [],
  };
  editor = e;

  for (const m of p?.models ?? []) {
    addModelRow(e, m.id, m.name);
    const r = e.rows[e.rows.length - 1]!;
    r.efforts.value = (m.reasoning_efforts ?? []).join(',');
    if (m.context_window != null) r.ctx.value = String(m.context_window);
    if (m.max_output_tokens != null) r.maxOut.value = String(m.max_output_tokens);
  }

  const addM = el('button', 'btn-mini', '+ 添加模型') as HTMLButtonElement;
  addM.type = 'button';
  addM.addEventListener('click', () => addModelRow(e));
  card.appendChild(addM);

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

  fetchBtn.addEventListener('click', () => {
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
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = '获取失败：' + (r.error || '—');
          return;
        }
        const got = r.models ?? [];
        let added = 0;
        for (const m of got) {
          const dup = e.rows.some((x) => x.id.value.trim() === m.id);
          if (!dup) {
            addModelRow(e, m.id, m.id);
            added++;
          }
        }
        status.className = 'prov-editor-status ok';
        status.textContent = '已获取 ' + got.length + ' 个模型（新增 ' + added + '）· 请保存以生效';
      })
      .catch((err: unknown) => {
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
        closeEditor();
        void loadProviders();
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = '保存失败：' + fmtErr(err);
        save.disabled = false;
      });
  });

  cancel.addEventListener('click', closeEditor);
  actions.appendChild(cancel);
  actions.appendChild(save);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  name.focus();
}

export function initProvidersSection(): void {
  need<HTMLButtonElement>('#btnAddProvider').addEventListener('click', () => openEditor(null));
}
