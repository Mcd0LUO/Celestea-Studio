// ============================================================================
// Celestea Studio — bootstrap / wiring (TS + Vite).
// 主题 → statusline → 面板 → 聊天主循环 → SSE。
// ============================================================================
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/statusline.css';

import { api } from './api';
import { connectSse, initChatInput, setStatus } from './chat';
import { initConfigModal } from './ui/config';
import { initSessionsPanel } from './ui/sessions';
import { initToolsPanel } from './ui/tools';
import { initWorkerPanel } from './ui/workerPanel';
import { Statusline } from './statusline';
import { S } from './state';
import { initTheme, setupThemeSwitcher } from './theme';
import { need } from './utils/dom';

function initHealth(statusline: Statusline): void {
  void api
    .health()
    .then((h) => {
      const chip = need<HTMLElement>('#modelChip');
      chip.textContent = h.model || '—';
      chip.title = (h.base_url || '') + ' · ' + (h.name || '');
      need<HTMLElement>('#sideFoot').textContent = (h.base_url || '') + ' · ' + h.model;
      // /api/status 未上线前，用 health 的模型填补 statusline
      if (h.model) statusline.merge({ model: h.model });
      if (!S.streaming) setStatus('就绪 · 在线', 'ok');
    })
    .catch(() => {
      need<HTMLElement>('#modelChip').textContent = '离线';
      setStatus('后端不可达', 'err');
    });
}

function init(): void {
  // 1) 主题（夜航黑灰默认；localStorage 持久化；顶栏按钮循环切换色卡）
  initTheme('night');
  setupThemeSwitcher(need<HTMLButtonElement>('#btnTheme'));

  // 2) statusline（/api/status 轮询 + SSE 增量，发送栏正上方）
  const statusline = new Statusline();
  statusline.start();

  // 3) 左侧面板
  const sideFoot = need<HTMLElement>('#sideFoot');
  initToolsPanel(sideFoot);
  initSessionsPanel();
  initWorkerPanel();

  // 4) 配置弹层
  initConfigModal();

  // 5) 聊天主循环 + SSE
  initChatInput();
  initHealth(statusline);
  connectSse(statusline);

  // 6) 侧栏开关
  need<HTMLButtonElement>('#btnSidebar').addEventListener('click', () => {
    need<HTMLElement>('#app').classList.toggle('no-sidebar');
  });

  need<HTMLTextAreaElement>('#input').focus();
}

// type=module 脚本为 deferred 执行 → DOM 已就绪
init();
