// ============================================================================
// state.ts — 状态层（单一职责）：当前 turn 的全局 UI 状态，纯数据、无 DOM。
// 视图句柄（AssistantView 等）在 ui/view.ts；布局状态在 ui/sidebar.ts 内部。
// ============================================================================
import type { ConnState, SessionInfo } from './types';
import type { AssistantView } from './ui/view';

/** 历史回放视图（只读）：当前展示的会话；null = 主会话实时模式。 */
export interface HistoryView {
  id: string;
  title: string;
}

export interface AppState {
  /** current turn id (null when idle) */
  turn: number | null;
  streaming: boolean;
  /** turn start timestamp for the elapsed timer */
  t0: number;
  conn: ConnState;
  assistant: AssistantView | null;
  sessions: SessionInfo[];
  selSession: string | null;
  /** 历史只读回放（null = 主会话实时） */
  history: HistoryView | null;
  /** elapsed-seconds timer for the bottom statusbar */
  msgTimer: number | null;
}

export const S: AppState = {
  turn: null,
  streaming: false,
  t0: 0,
  conn: 'connecting',
  assistant: null,
  sessions: [],
  selSession: null,
  history: null,
  msgTimer: null,
};
