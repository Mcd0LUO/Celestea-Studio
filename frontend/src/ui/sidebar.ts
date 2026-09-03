// ============================================================================
// ui/sidebar.ts — 侧栏布局（单一职责）：
//   1) 收起/展开（顶栏按钮，localStorage 持久）
//   2) 拖宽（与主区之间的分隔条，pointer 事件，min/max 约束，localStorage 持久）
// ============================================================================
import { need } from '../utils/dom';

const STORAGE_COLLAPSED = 'celestea-studio.sidebar-collapsed';
const STORAGE_WIDTH = 'celestea-studio.sidebar-width';

export const SIDEBAR_DEFAULT = 316;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 560;

function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

function readStoredCollapsed(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_COLLAPSED);
    // 未存过：窄屏默认收起，宽屏默认展开
    if (v !== null) return v === '1';
    return window.innerWidth < 880;
  } catch {
    return false;
  }
}

function readStoredWidth(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_WIDTH));
    return Number.isFinite(v) && v > 0 ? v : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function initSidebar(): void {
  const app = need<HTMLElement>('#app');
  const sidebar = need<HTMLElement>('#sidebar');
  const resizer = need<HTMLElement>('#sidebarResizer');
  const btn = need<HTMLButtonElement>('#btnSidebar');

  let collapsed = readStoredCollapsed();

  const applyCollapsed = () => {
    app.classList.toggle('sidebar-collapsed', collapsed);
    btn.textContent = collapsed ? '展开' : '收起';
    btn.title = collapsed ? '展开左侧面板' : '收起左侧面板';
  };
  const applyWidth = (w: number) => {
    sidebar.style.width = clampWidth(w) + 'px';
  };

  applyCollapsed();
  applyWidth(readStoredWidth());

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_COLLAPSED, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    applyCollapsed();
  });

  // ---- 拖动分隔条（pointer 事件；自动捕获指针） ----
  let dragging = false;
  let startX = 0;
  let startW = 0;

  const persistWidth = () => {
    try {
      localStorage.setItem(STORAGE_WIDTH, String(Math.round(sidebar.getBoundingClientRect().width)));
    } catch {
      /* storage unavailable */
    }
  };

  resizer.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    applyWidth(startW + (e.clientX - startX));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    persistWidth();
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => {
    applyWidth(SIDEBAR_DEFAULT);
    persistWidth();
  });
}
