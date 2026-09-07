// ============================================================================
// Celestea Studio — bootstrap / wiring (TS + Vite)。
// 主题 → 侧栏(收起/拖宽) → statusline → 面板(工具/会话) → 配置弹层 →
// 聊天主循环 → SSE。所有具体职责均在 api/sse/state/statusline/theme/ui 模块内，
// 本文件只做初始化与模块装配。
// ============================================================================
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/statusline.css';

import './styles/settings.css';
import './styles/sessions.css';
import './styles/rail.css';

import { api } from './api';
import { connectSse, initChat } from './chat';
import { setStatus } from './ui/statusbar';
import { initSettingsPage } from './ui/config';
import { initSessionsPanel } from './ui/sessions';
import { restoreCliMainHistory } from './ui/restore';
import { initRail } from './ui/rail';
import { initSidebar } from './ui/sidebar';
import { Statusline } from './statusline';
import { S } from './state';
import { initTheme, setupThemeSwitcher } from './theme';
import { need } from './utils/dom';

/** 健康信息 → 侧栏脚注 + statusline（模型兜底）。 */
function refreshHealthChip(statusline: Statusline): void {
  void api
    .health()
    .then((h) => {
      need<HTMLElement>('#sideFoot').textContent = (h.base_url || '') + ' · ' + h.model;
      // /api/status 未上线前，用 health 的模型填补 statusline
      if (h.model) statusline.merge({ model: h.model });
      if (!S.streaming) setStatus('就绪 · 在线', 'ok');
    })
    .catch(() => {
      if (!S.streaming) setStatus('后端不可达', 'err');
    });
}

function init(): void {
  // 1) 主题（夜航黑灰默认；localStorage 持久化；顶栏按钮循环切换色卡）
  initTheme('night');
  setupThemeSwitcher(need<HTMLButtonElement>('#btnTheme'));

  // 2) 侧栏：收起/展开 + 拖宽（状态持久）
  initSidebar();

  // 3) statusline（/api/status 轮询 + SSE 增量，发送栏正上方）
  const statusline = new Statusline();
  statusline.start();

  // 4) 左侧面板：工作区/会话树（W227；工具清单已迁至「通用设置」页）
  initSessionsPanel();

  // 5) 「通用设置」页（取代原 #modal 弹层；热调 + 工具列表；保存成功后刷新健康信息）
  initSettingsPage();

  // 6) 消息 rail（左侧灵动长条）+ 聊天主循环 + 启动恢复 + SSE
  initRail();
  initChat();
  refreshHealthChip(statusline);
  void restoreCliMainHistory();
  connectSse(statusline);

  // 配置保存成功 → 顶栏/statusline 反映新模型
  window.addEventListener('studio:config-saved', () => refreshHealthChip(statusline));

  need<HTMLTextAreaElement>('#input').focus();
}

// type=module 脚本为 deferred 执行 → DOM 已就绪
init();
