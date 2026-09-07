// ============================================================================
// SSE client — typed wrappers around the /api/events stream.
// Event names preserved: status/text/thinking/tool/tool_result/done.
// 责任边界：仅解析/分发事件，不做状态归并（归并在 chat.ts）。
// Each event: {"turn":N,"seq":M,"payload":{...}, ...}
// ============================================================================
import type {
  ConnState,
  ContextPayload,
  DonePayload,
  SseEnvelope,
  SseEventName,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from './types';

export interface SseHandlerMap {
  status: (p: StatusPayload) => void;
  text: (p: TextPayload) => void;
  thinking: (p: ThinkingPayload) => void;
  tool: (p: ToolPayload) => void;
  tool_result: (p: ToolResultPayload) => void;
  done: (p: DonePayload) => void;
  context: (p: ContextPayload) => void;
}

export type SseHandler<K extends SseEventName> = SseHandlerMap[K];

const EVENT_NAMES: readonly SseEventName[] = [
  'status',
  'text',
  'thinking',
  'tool',
  'tool_result',
  'done',
  'context',
];

export class SseClient {
  private es: EventSource | null = null;
  private handlers = new Map<SseEventName, Set<(p: unknown) => void>>();
  private connCbs = new Set<(state: ConnState) => void>();

  constructor(readonly url = '/api/events') {}

  on<K extends SseEventName>(name: K, handler: SseHandler<K>): void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (p: unknown) => void);
  }

  onConn(cb: (state: ConnState) => void): void {
    this.connCbs.add(cb);
  }

  connect(): void {
    this.close();
    const es = new EventSource(this.url);
    this.es = es;
    es.onopen = () => this.emitConn('online');
    es.onerror = () => this.emitConn('down');
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (e: MessageEvent<string>) => {
        try {
          const env = JSON.parse(e.data) as SseEnvelope;
          const payload = env.payload !== undefined ? env.payload : env;
          this.emit(name, payload);
        } catch (err) {
          console.warn('[sse] failed to parse', name, err);
        }
      });
    }
  }

  close(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  private emit(name: SseEventName, payload: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        (h as (p: unknown) => void)(payload);
      } catch (err) {
        console.warn('[sse] handler failed for', name, err);
      }
    }
  }

  private emitConn(state: ConnState): void {
    for (const cb of this.connCbs) {
      try {
        cb(state);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
