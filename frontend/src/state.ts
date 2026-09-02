// ============================================================================
// Global UI state (single conversation turn + panels)
// ============================================================================
import type { ConnState, SessionInfo } from './types';

export interface ToolOpView {
  card: HTMLDivElement;
  state: HTMLElement;
  label: HTMLElement;
}

export interface AssistantView {
  root: HTMLElement;
  bubble: HTMLDivElement;
  think: HTMLDetailsElement;
  thinkBody: HTMLElement;
  cards: HTMLDivElement;
  content: HTMLDivElement;
  text: string;
  thinkText: string;
  ops: Map<string, ToolOpView>;
  steps: number;
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
  /** elapsed-seconds timer for the bottom statusbar */
  msgTimer: number | null;
  /** auto-refresh timer for the worker status panel */
  workerAutoTimer: number | null;
}

export const S: AppState = {
  turn: null,
  streaming: false,
  t0: 0,
  conn: 'connecting',
  assistant: null,
  sessions: [],
  selSession: null,
  msgTimer: null,
  workerAutoTimer: null,
};
