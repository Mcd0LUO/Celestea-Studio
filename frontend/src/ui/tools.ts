// ============================================================================
// ui/tools.ts — 「通用设置」页内的工具列表区块（单一职责）：
//   GET /api/tools → 渲染 name + description 表格；接口缺失时优雅降级。
//   （聊天消息里的工具卡片与此无关，见 ui/toolcards.ts。）
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { ToolInfo } from '../types';

const boxEl = need<HTMLElement>('#settingsTools');
const countEl = need<HTMLElement>('#toolsCount');

function renderTools(tools: ToolInfo[] | undefined): void {
  const arr = tools ?? [];
  countEl.textContent = String(arr.length);
  boxEl.innerHTML = '';
  if (!arr.length) {
    boxEl.appendChild(el('div', 'side-note', '未获取到工具'));
    return;
  }
  const table = el('table', 'tools-table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', null, '名称'));
  hr.appendChild(el('th', null, '描述'));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const t of arr) {
    const tr = el('tr');
    const tdName = el('td', 'tools-name');
    tdName.textContent = String(t.name);
    tdName.title = String(t.name);
    tr.appendChild(tdName);
    const tdDesc = el('td', 'tools-desc');
    tdDesc.textContent = t.description ? String(t.description) : '—';
    tr.appendChild(tdDesc);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  boxEl.appendChild(table);
}

/** 载入并渲染工具清单区块（打开设置页 / 点击刷新时调用）。 */
export function loadToolsSection(): Promise<void> {
  boxEl.innerHTML = '<div class="side-note">加载中…</div>';
  return api
    .tools()
    .then((d) => {
      renderTools(d.tools);
    })
    .catch((err: unknown) => {
      countEl.textContent = '—';
      boxEl.innerHTML = '';
      boxEl.appendChild(el('div', 'side-note err', '工具接口不可用'));
      boxEl.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    });
}

export function initToolsSection(): void {
  need<HTMLButtonElement>('#btnReloadTools').addEventListener('click', () => {
    void loadToolsSection();
  });
}
