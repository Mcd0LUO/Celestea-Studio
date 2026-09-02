// ============================================================================
// 左侧「Worker 编排」面板：spawn / send / status 三个表单。
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { WorkerInfo } from '../types';
import { S } from '../state';

// ---- result helpers ------------------------------------------------------------

function showResult(node: HTMLElement, text: string, kind?: string): void {
  node.className = 'wf-result show' + (kind ? ' ' + kind : '');
  node.textContent = text;
}

function setResultErr(node: HTMLElement, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  showResult(node, '请求失败：' + msg, 'err');
}

function prettyRows(obj: Record<string, unknown>, keys: string[]): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];
  for (const k of keys) {
    const raw = obj[k];
    if (raw === undefined || raw === null) continue;
    let v: unknown = raw;
    if (typeof v === 'object') {
      try {
        v = JSON.stringify(v);
      } catch {
        v = String(v);
      }
    }
    rows.push({ k, v: String(v) });
  }
  return rows;
}

function renderCards(box: HTMLElement, list: WorkerInfo[] | undefined, keys: string[]): void {
  if (!list || !list.length) {
    box.appendChild(el('div', 'side-note', '无 worker 记录'));
    return;
  }
  for (const w of list) {
    const card = el('div', 'wcard');
    for (const row of prettyRows(w as unknown as Record<string, unknown>, keys)) {
      const line = el('div', 'wcard-line');
      line.appendChild(el('span', 'wcard-k', row.k));
      line.appendChild(el('span', 'wcard-v', row.v));
      card.appendChild(line);
    }
    box.appendChild(card);
  }
}

// ---- forms -----------------------------------------------------------------------

function bindSpawnForm(): void {
  const form = need<HTMLFormElement>('#spawnForm');
  const node = need<HTMLElement>('#spawnResult');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const wid = need<HTMLInputElement>('#spawnWid').value.trim();
    const brief = need<HTMLTextAreaElement>('#spawnBrief').value.trim();
    if (!wid) {
      showResult(node, '请填写 worker 编号', 'err');
      return;
    }
    if (!brief) {
      showResult(node, '请填写任务简报', 'err');
      return;
    }
    node.className = 'wf-result show';
    node.textContent = '创建中…';
    void api
      .workerSpawn({
        wid,
        brief,
        title: need<HTMLInputElement>('#spawnTitle').value.trim() || undefined,
        model: need<HTMLInputElement>('#spawnModel').value.trim() || undefined,
      })
      .then((d) => {
        if (d.ok === false) {
          showResult(node, (d.error || 'spawn 失败') + (d.step ? ' · step:' + d.step : ''), 'err');
          return;
        }
        showResult(node, 'ok · ' + (d.sessionId || '') + '\n' + (d.title || '') + ' · ' + (d.wid || wid), 'ok');
        void workerStatus();
      })
      .catch((err: unknown) => setResultErr(node, err));
  });
}

function bindSendForm(): void {
  const form = need<HTMLFormElement>('#sendForm');
  const node = need<HTMLElement>('#sendResult');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = need<HTMLInputElement>('#sendTarget').value.trim();
    const content = need<HTMLTextAreaElement>('#sendContent').value.trim();
    if (!target) {
      showResult(node, '请填写目标会话', 'err');
      return;
    }
    if (!content) {
      showResult(node, '请填写消息内容', 'err');
      return;
    }
    node.className = 'wf-result show';
    node.textContent = '发送中…';
    void api
      .workerSend({ target, content })
      .then((d) => {
        if (d.ok === false) {
          showResult(node, (d.error || 'send 失败') + (d.step ? ' · step:' + d.step : ''), 'err');
          return;
        }
        showResult(node, 'ok · delivered=' + (d.delivered !== false ? 'true' : 'false'), 'ok');
      })
      .catch((err: unknown) => setResultErr(node, err));
  });
}

function workerStatus(): Promise<void> {
  const node = need<HTMLElement>('#statusResult');
  const wid = need<HTMLInputElement>('#statusWid').value.trim() || 'W217';
  node.className = 'wf-result show';
  node.textContent = '查询中…';
  return api
    .workerStatus(wid)
    .then((d) => {
      node.innerHTML = '';
      if (d.ok === false && d.error) {
        node.appendChild(el('div', 'side-note err', 'error: ' + d.error));
      }
      let head = 'total=' + (d.total !== undefined ? String(d.total) : '?');
      const byStatus = d.by_status;
      if (byStatus) {
        head += ' · ' + Object.keys(byStatus)
          .map((k) => k + ':' + String(byStatus[k]))
          .join(' ');
      }
      node.appendChild(el('div', 'side-note', head));
      renderCards(node, d.workers, ['wid', 'title', 'status', 'phase', 'sessionId', 'model', 'workspace', 'cwd', 'live']);
    })
    .catch((err: unknown) => setResultErr(node, err));
}

export function initWorkerPanel(): void {
  bindSpawnForm();
  bindSendForm();
  need<HTMLButtonElement>('#btnStatusQuery').addEventListener('click', () => {
    void workerStatus();
  });
  const auto = need<HTMLInputElement>('#statusAuto');
  auto.addEventListener('change', () => {
    if (auto.checked) {
      void workerStatus();
      if (S.workerAutoTimer !== null) window.clearInterval(S.workerAutoTimer);
      S.workerAutoTimer = window.setInterval(() => void workerStatus(), 8000);
    } else if (S.workerAutoTimer !== null) {
      window.clearInterval(S.workerAutoTimer);
      S.workerAutoTimer = null;
    }
  });
  void workerStatus();
}
