// ============================================================================
// ui/config.ts — 配置面板（单一职责）：
//   打开时 GET /api/config（+ /api/status 补充窗口信息）→ 渲染可热调表单；
//   model / reasoning_effort 优先取后端 available 清单（缺失时降级）；
//   保存 POST /api/config {patch}（404/405 时给出明确提示）。
// ============================================================================
import { api, ApiError } from '../api';
import { el, need } from '../utils/dom';
import type { ConfigInfo, ConfigPatch } from '../types';

const box = need<HTMLElement>('#configBody');
const statusHint = need<HTMLElement>('#cfgHint');

/** 引擎已知档位（后端未发布 available.efforts 时的降级选项）。 */
const EFFORT_FALLBACK: readonly string[] = ['low', 'medium', 'high'];

// ---- 小部件 -------------------------------------------------------------------

const ctl = {
  select: (options: { value: string; label: string }[], current?: string | null): HTMLSelectElement => {
    const s = el('select', 'cfg-input');
    for (const o of options) {
      const opt = el('option', null, o.label) as HTMLOptionElement;
      opt.value = o.value;
      s.appendChild(opt);
    }
    const cur = current ?? '';
    if (cur !== '' && !options.some((o) => o.value === cur)) {
      const extra = el('option', null, cur) as HTMLOptionElement;
      extra.value = cur;
      s.appendChild(extra);
    }
    s.value = cur;
    return s;
  },
  text: (value: string, placeholder?: string, type = 'text'): HTMLInputElement => {
    const i = el('input', 'cfg-input') as HTMLInputElement;
    i.type = type;
    i.value = value;
    if (placeholder) i.placeholder = placeholder;
    return i;
  },
  num: (value: number | null | undefined, placeholder: string): HTMLInputElement => {
    const i = el('input', 'cfg-input') as HTMLInputElement;
    i.type = 'number';
    i.min = '0';
    i.placeholder = placeholder;
    if (value !== undefined && value !== null) i.value = String(value);
    return i;
  },
  field: (label: string, control: HTMLElement, hint?: string): HTMLElement => {
    const row = el('label', 'cfg-field');
    row.appendChild(el('span', 'cfg-label', label));
    row.appendChild(control);
    if (hint) row.appendChild(el('span', 'cfg-hint', hint));
    return row;
  },
};

function toNum(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// ---- 表单 ---------------------------------------------------------------------

function renderForm(cfg: ConfigInfo, statusWindow: number | null): void {
  box.innerHTML = '';
  const form = el('form', 'cfg-form');

  const models = Array.isArray(cfg.available?.models) ? cfg.available!.models!.map(String) : [];
  const efforts = Array.isArray(cfg.available?.efforts) ? cfg.available!.efforts!.map(String) : [];

  const modelCtl: HTMLSelectElement | HTMLInputElement = models.length
    ? ctl.select(models.map((m) => ({ value: m, label: m })), cfg.model ?? null)
    : ctl.text(cfg.model ?? '', '模型名（后端未提供可选清单，手动输入）');
  form.appendChild(ctl.field('模型', modelCtl, models.length ? '' : '后端未返回 available.models'));

  const effortOptions: { value: string; label: string }[] = [{ value: '', label: '标准（未设置）' }];
  for (const e of efforts.length ? efforts : EFFORT_FALLBACK) {
    effortOptions.push({ value: e, label: e });
  }
  const effortCtl = ctl.select(effortOptions, cfg.reasoning_effort ?? null);
  form.appendChild(ctl.field('推理档位', effortCtl, efforts.length ? '' : '后端未返回 available.efforts'));

  const baseUrlCtl = ctl.text(cfg.base_url ?? '', 'https://…/v1');
  form.appendChild(ctl.field('Base URL', baseUrlCtl));

  const apiKeyCtl = ctl.text('', '留空保持不变（后端不会回传密钥）', 'password');
  form.appendChild(ctl.field('API Key', apiKeyCtl, '仅用于热调；不会从后端读取明文'));

  const ctxWin = cfg.context_window ?? cfg.context_window_tokens ?? statusWindow;
  const ctxCtl = ctl.num(ctxWin, '未设置（后端未暴露）');
  form.appendChild(ctl.field('上下文窗口', ctxCtl));

  const maxOutCtl = ctl.num(cfg.max_output_tokens ?? null, '未限制');
  form.appendChild(ctl.field('最大输出 tokens', maxOutCtl));

  const maxStepsCtl = ctl.num(cfg.max_steps ?? null, '未设置');
  form.appendChild(ctl.field('最大步数', maxStepsCtl));

  const sysCtl = el('textarea', 'cfg-input cfg-sys') as HTMLTextAreaElement;
  sysCtl.rows = 6;
  sysCtl.placeholder = '系统提示词（留空 = 保持默认）';
  sysCtl.value = cfg.system_prompt ?? '';
  form.appendChild(ctl.field('系统提示词', sysCtl, '发送给模型的指令前缀'));

  // ---- 操作行 ----
  const actions = el('div', 'cfg-actions');
  const saveBtn = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  saveBtn.type = 'button';
  const reloadBtn = el('button', 'btn btn-soft', '重新载入') as HTMLButtonElement;
  reloadBtn.type = 'button';
  actions.appendChild(saveBtn);
  actions.appendChild(reloadBtn);
  form.appendChild(actions);

  const status = el('div', 'cfg-status');
  form.appendChild(status);

  box.appendChild(form);

  // ---- 校验 + 保存 ----
  const parseNum = (ctl2: HTMLInputElement, name: string): number | null => {
    const n = toNum(ctl2.value);
    if (Number.isNaN(n)) {
      status.className = 'cfg-status err';
      status.textContent = '「' + name + '」不是合法数字';
      throw new Error('bad number: ' + name);
    }
    return n;
  };

  const doSave = () => {
    status.className = 'cfg-status';
    status.textContent = '';
    const patch: ConfigPatch = {};

    const model = modelCtl.value.trim();
    if (model !== '' && model !== (cfg.model ?? '')) patch.model = model;
    const baseUrl = baseUrlCtl.value.trim();
    if (baseUrl !== '' && baseUrl !== (cfg.base_url ?? '')) patch.base_url = baseUrl;
    if (apiKeyCtl.value.trim() !== '') patch.api_key = apiKeyCtl.value.trim();
    patch.reasoning_effort = effortCtl.value === '' ? null : effortCtl.value;
    patch.context_window = parseNum(ctxCtl, '上下文窗口');
    patch.max_output_tokens = parseNum(maxOutCtl, '最大输出 tokens');
    patch.max_steps = parseNum(maxStepsCtl, '最大步数');
    patch.system_prompt = sysCtl.value;

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    void api
      .saveConfig(patch)
      .then((d) => {
        status.className = 'cfg-status ok';
        status.textContent = d.ok === false ? '保存失败：' + (d.error || '后端拒绝') : '已保存 · 后端已应用';
        if (d.ok !== false) window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        status.className = 'cfg-status err';
        const e = err as Error;
        status.textContent = err instanceof ApiError && (err.status === 405 || err.status === 404)
          ? '后端未开放配置保存（HTTP ' + err.status + '）：当前后端无 POST /api/config 端点，请更新后端或编辑 celestea.toml 重启。'
          : '保存失败：' + (e.message || String(err));
      })
      .finally(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      });
  };

  const doReload = () => {
    void loadConfig();
  };

  saveBtn.addEventListener('click', doSave);
  reloadBtn.addEventListener('click', doReload);
}

/** 载入当前配置并渲染表单（含 status 补充窗口信息）。 */
export async function loadConfig(): Promise<void> {
  box.innerHTML = '<div class="side-note">加载中…</div>';
  let cfg: ConfigInfo;
  try {
    cfg = await api.config();
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(el('div', 'side-note err', '配置接口不可用'));
    box.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    statusHint.textContent = '';
    return;
  }
  let statusWindow: number | null = null;
  try {
    const st = await api.status();
    statusWindow = st?.context_usage?.window ?? null;
  } catch {
    /* status 仅作窗口补充，缺失无碍 */
  }
  try {
    renderForm(cfg, statusWindow);
    statusHint.textContent = '数据源：GET /api/config' +
      (statusWindow !== null ? ' · 窗口补充：GET /api/status' : '') +
      ' · 保存 POST /api/config（后端需支持热调）';
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(el('div', 'side-note err', '配置接口不可用'));
    box.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    statusHint.textContent = '';
  }
}

function openModal(): void {
  need<HTMLElement>('#modal').classList.remove('hidden');
  void loadConfig();
}

function closeModal(): void {
  need<HTMLElement>('#modal').classList.add('hidden');
}

export function initConfigModal(): void {
  need<HTMLElement>('#btnConfig').addEventListener('click', openModal);
  need<HTMLElement>('#modelChip').addEventListener('click', openModal);
  need<HTMLElement>('#btnModalClose').addEventListener('click', closeModal);
  need<HTMLElement>('#btnConfigReload').addEventListener('click', () => void loadConfig());
  need<HTMLElement>('#modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}
