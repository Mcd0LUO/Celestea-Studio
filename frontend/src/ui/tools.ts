// ============================================================================
// 左侧「工具」面板：工具清单加载与渲染。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { ToolInfo } from '../types';

const listEl = need<HTMLElement>('#toolList');
const countEl = need<HTMLElement>('#toolCount');

function renderTools(tools: ToolInfo[] | undefined): void {
  const arr = tools ?? [];
  countEl.textContent = String(arr.length);
  listEl.innerHTML = '';
  if (!arr.length) {
    listEl.appendChild(el('div', 'side-note err', '未获取到工具'));
    return;
  }
  for (const t of arr) {
    const item = el('div', 'tool-item');
    item.title = t.description || '';
    item.appendChild(el('div', 'tool-item-name', String(t.name)));
    if (t.description) item.appendChild(el('div', 'tool-item-desc', String(t.description)));
    listEl.appendChild(item);
  }
}

/** Load-and-render the tool catalog; reports status into the sidebar footer. */
export function loadTools(sideFoot: HTMLElement): Promise<void> {
  // mark loading unless a list is already shown
  if (!listEl.childElementCount) {
    listEl.innerHTML = '<div class="side-note">加载中…</div>';
  }
  return api
    .tools()
    .then((d) => {
      renderTools(d.tools);
      sideFoot.textContent = '工具接口正常 · ' + (d.tools ?? []).length + ' 项';
    })
    .catch((err: unknown) => {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'side-note err', '工具接口不可用'));
      listEl.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
      sideFoot.textContent = '工具接口异常：' + (err instanceof Error ? err.message : String(err));
    });
}

export function initToolsPanel(sideFoot: HTMLElement): void {
  need<HTMLButtonElement>('#btnReloadTools').addEventListener('click', () => {
    void loadTools(sideFoot);
  });
  void loadTools(sideFoot);
}
