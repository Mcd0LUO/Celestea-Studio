// ============================================================================
// 配置弹层：/api/config 只读展示（键值列表，system_prompt 走等宽预排版）。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';

const CFG_LABELS: Record<string, string> = {
  model: '模型',
  base_url: 'Base URL',
  max_steps: '最大步数',
  max_parallel_tool_calls: '并行工具数',
  reasoning_effort: '推理档位',
  max_output_tokens: '最大输出 tokens',
  system_prompt: '系统提示词',
};

const box = need<HTMLElement>('#configBody');

export function loadConfig(): Promise<void> {
  box.innerHTML = '<div class="side-note">加载中…</div>';
  return api
    .config()
    .then((cfg) => {
      box.innerHTML = '';
      let rendered = false;
      for (const key of Object.keys(CFG_LABELS)) {
        const value = cfg[key];
        if (value === undefined || value === null) continue;
        const row = el('div', 'cfg-row');
        row.appendChild(el('div', 'cfg-k', CFG_LABELS[key]));
        const v = el('div', 'cfg-v' + (key === 'system_prompt' ? ' pre' : ' mono'));
        v.textContent = String(value);
        row.appendChild(v);
        box.appendChild(row);
        rendered = true;
      }
      if (!rendered) box.appendChild(el('div', 'side-note', '无配置信息'));
    })
    .catch((err: unknown) => {
      box.innerHTML = '';
      box.appendChild(el('div', 'side-note err', '配置接口不可用'));
      box.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    });
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
  need<HTMLElement>('#modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}
