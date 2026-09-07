// ============================================================================
// ui/config.ts — 「通用设置」页（左导航 + 右内容，取代原 #modal 弹层）：
//   导航页：「通用配置」（热调表单）/「工具」（清单表格）/「会话」（管理）。
//   模型下拉用 available.models（value=id / label=name，缺失降级手输）；
//   effort 档位 + 「标准（清除）」；保存 POST /api/config（409/404/405/400 有提示）。
// ============================================================================
import { api, ApiError } from '../api';
import { el, need } from '../utils/dom';
import type { ConfigInfo, ConfigPatch } from '../types';
import { initToolsSection, loadToolsSection } from './tools';
import { clearCurrentSession, loadSessionBars } from './sessions';

const page = need<HTMLElement>('#settingsPage');
const box = need<HTMLElement>('#settingsConfig');
const statusHint = need<HTMLElement>('#settingsHint');

/** 引擎已知档位（后端未发布 available.efforts 时的降级选项）。 */
const EFFORT_FALLBACK: readonly string[] = ['low', 'high', 'max'];

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
      // 当前值不在清单（如 pinned 具体版本）：保留为附加选项，避免误改
      const extra = el('option', null, cur + '（当前）') as HTMLOptionElement;
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

  // W227 修复：available.models 是 {id,name,reasoning} 对象数组——
  // 选项 value=id、label=name（此前 map(String) 渲染成 "[object Object]"）。
  const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
  const efforts = Array.isArray(cfg.available?.efforts) ? cfg.available.efforts : [];

  const modelCtl: HTMLSelectElement | HTMLInputElement = models.length
    ? ctl.select(models.map((m) => ({ value: m.id, label: m.name })), cfg.model ?? null)
    : ctl.text(cfg.model ?? '', '模型名（后端未提供可选清单，手动输入）');
  form.appendChild(ctl.field('模型', modelCtl, models.length ? '' : '后端未返回 available.models'));

  const effortOptions: { value: string; label: string }[] = [{ value: '', label: '标准（清除）' }];
  for (const e of efforts.length ? efforts : EFFORT_FALLBACK) {
    effortOptions.push({ value: e, label: e });
  }
  const effortCtl = ctl.select(effortOptions, cfg.reasoning_effort ?? null);
  form.appendChild(ctl.field('推理档位', effortCtl, efforts.length ? '空 = 标准档' : '后端未返回 available.efforts'));

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
        if (err instanceof ApiError && err.status === 409) {
          status.textContent = '轮次进行中（409）：配置将在本轮结束后生效，请稍后重新保存。';
        } else if (err instanceof ApiError && (err.status === 405 || err.status === 404)) {
          status.textContent = '后端未开放配置保存（HTTP ' + err.status + '）：当前后端无 POST /api/config 端点，请更新后端或编辑 celestea.toml 重启。';
        } else {
          status.textContent = '保存失败：' + (e.message || String(err));
        }
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

// ---- 左导航 + 右内容 -----------------------------------------------------------

const PANES = ['config', 'tools', 'sessions'] as const;
type PaneName = (typeof PANES)[number];

let currentPane: PaneName = 'config';

function paneEl(name: PaneName): HTMLElement {
  return need<HTMLElement>('.settings-pane[data-pane="' + name + '"]');
}

function navEl(name: PaneName): HTMLElement {
  return need<HTMLElement>('.settings-nav-item[data-page="' + name + '"]');
}

function showPane(name: PaneName): void {
  currentPane = name;
  for (const n of PANES) paneEl(n).classList.toggle('active', n === name);
  for (const n of PANES) navEl(n).classList.toggle('active', n === name);
  if (name === 'config') {
    void loadConfig();
  } else if (name === 'tools') {
    void loadToolsSection();
  } else {
    void loadSessionBars(
      need<HTMLElement>('#settingsSessions'),
      need<HTMLElement>('#settingsSessionCount'),
    );
  }
}

function reloadCurrentPane(): void {
  if (currentPane === 'config') void loadConfig();
  else if (currentPane === 'tools') void loadToolsSection();
  else {
    void loadSessionBars(
      need<HTMLElement>('#settingsSessions'),
      need<HTMLElement>('#settingsSessionCount'),
    );
  }
}

// ---- 页面开关 ----------------------------------------------------------------

export function openSettings(): void {
  page.classList.remove('hidden');
  showPane('config');
}

export function closeSettings(): void {
  page.classList.add('hidden');
}

export function initSettingsPage(): void {
  need<HTMLElement>('#btnConfig').addEventListener('click', openSettings);
  need<HTMLElement>('#btnSettingsClose').addEventListener('click', closeSettings);
  need<HTMLElement>('#btnSettingsReload').addEventListener('click', reloadCurrentPane);
  for (const n of PANES) {
    navEl(n).addEventListener('click', () => showPane(n));
  }
  need<HTMLButtonElement>('#btnReloadSessionsSettings').addEventListener('click', () => {
    void loadSessionBars(
      need<HTMLElement>('#settingsSessions'),
      need<HTMLElement>('#settingsSessionCount'),
    );
  });
  need<HTMLButtonElement>('#btnClearSessSettings').addEventListener('click', () => {
    clearCurrentSession();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !page.classList.contains('hidden')) closeSettings();
  });
  initToolsSection(); // #btnReloadTools
}
