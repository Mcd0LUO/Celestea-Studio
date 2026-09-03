// ============================================================================
// ui/view.ts — 视图层合同：消息流/工具卡片的 DOM 句柄（与 API 合同分离）。
// ============================================================================

export interface ToolOpView {
  card: HTMLElement;
  state: HTMLElement;
  label: HTMLElement;
}

export interface AssistantView {
  /** .msg.assistant 整列 */
  root: HTMLElement;
  /** 气泡容器 */
  bubble: HTMLDivElement;
  /** thinking 折叠块（默认收起；idle 时隐藏） */
  think: HTMLDetailsElement;
  thinkBody: HTMLElement;
  /** 思考时长徽标 */
  thinkTime: HTMLElement;
  /** 工具卡片容器 */
  cards: HTMLDivElement;
  /** markdown 正文容器 */
  content: HTMLDivElement;
  text: string;
  thinkText: string;
  ops: Map<string, ToolOpView>;
  steps: number;
}
