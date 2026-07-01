// ═══════════════════════════════════════════════════════════════
// Call Chain Tracer — 全链路追踪
// 记录方法入口参数、输出结果、耗时、错误，构建调用树。
// 无错误时也可回放查看每一步的数据加工过程。
// ═══════════════════════════════════════════════════════════════
import logger from '../logger';

export interface TraceSpan {
  id: string;
  parentId: string | null;
  name: string;
  context: string; // 模块名，如 Agent / LLMRouter / IntentParser
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  /** 入口参数摘要（避免记录全量消息体） */
  input: Record<string, unknown> | null;
  /** 返回结果摘要 */
  output: unknown | null;
  error: { message: string; stack: string } | null;
  children: TraceSpan[];
}

export interface TraceReport {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  totalDurationMs: number | null;
  rootSpan: TraceSpan;
  /** 是否发生错误 */
  hasError: boolean;
  /** 人类可读的调用链文本 */
  chainText: string;
}

let _spanIdCounter = 0;
function nextSpanId(): string {
  return 'span_' + (++_spanIdCounter) + '_' + Date.now().toString(36);
}

/**
 * 清理日志参数：避免记录整段消息体/大对象，
 * 字符串截断前 120 字，数组只记长度，对象只记摘要。
 */
function sanitizeLogArg(value: unknown, maxStrLen = 120): unknown {
  if (typeof value === 'string') {
    if (value.length > maxStrLen) return value.slice(0, maxStrLen) + `…(${value.length}字)`;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // 如果数组元素都是简单类型，保留前 3 个
    if (value.every(v => typeof v !== 'object' || v === null)) {
      return value.length <= 3 ? value : [value[0], value[1], value[2], `…(${value.length}项)`];
    }
    return `[${value.length} items]`;
  }
  if (value && typeof value === 'object') {
    // 检测是否 Error
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    // 大对象只记录 keys
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 5) {
      return `{${keys.slice(0, 5).join(', ')}, …(${keys.length}个字段)}`;
    }
    // 小型对象递归清理每个字段
    const sanitized: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      // 跳过 messages/memoryBlock 等大块
      if (['messages', 'memoryBlock', 'experienceBlock', 'context', 'identityVars'].includes(k)) {
        if (Array.isArray(v)) sanitized[k] = `[${v.length} items]`;
        else if (typeof v === 'string') sanitized[k] = `[${v.length} chars]`;
        else sanitized[k] = '[omitted]';
      } else {
        sanitized[k] = sanitizeLogArg(v, maxStrLen);
      }
    }
    return sanitized;
  }
  return value;
}

/**
 * 将 TraceSpan 树格式化为缩进文本（可读性强）
 */
function formatSpanTree(span: TraceSpan, depth = 0): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '┌─' : depth === 1 ? '├─' : '│  '.repeat(depth - 1) + '├─';
  const status = span.error ? '❌' : span.durationMs !== null ? '✅' : '⏳';
  const dur = span.durationMs !== null ? ` (${span.durationMs}ms)` : '';
  const inputStr = span.input ? ` ← ${JSON.stringify(span.input)}` : '';
  const outputStr = span.output !== null ? ` → ${formatOutputBrief(span.output)}` : '';
  const errorStr = span.error ? ` ERR: ${span.error.message}` : '';

  lines.push(`${indent}${prefix} [${span.context}] ${span.name}${dur}${inputStr}${outputStr}${errorStr}`);

  for (const child of span.children) {
    lines.push(...formatSpanTree(child, depth + 1));
  }

  if (depth === 0) {
    lines.push(`${indent}└─ end (${span.durationMs || '?'}ms${span.error ? ' ❌' : ' ✅'})`);
  }

  return lines;
}

function formatOutputBrief(output: unknown): string {
  if (output === null || output === undefined) return '∅';
  if (typeof output === 'string') return output.length > 60 ? output.slice(0, 60) + '…' : output;
  if (typeof output === 'object') {
    const s = JSON.stringify(sanitizeLogArg(output, 60));
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }
  return String(output);
}

// ====== Tracer ======

export class Tracer {
  private _sessionId: string;
  private _root: TraceSpan | null = null;
  private _stack: TraceSpan[] = [];
  private _spanMap = new Map<string, TraceSpan>();
  private _startedAt = Date.now();
  private _endedAt: number | null = null;
  private _hasError = false;

  constructor(sessionId: string) {
    this._sessionId = sessionId;
  }

  get sessionId(): string { return this._sessionId; }
  get hasError(): boolean { return this._hasError; }

  /**
   * 开始一个调用 span，压入调用栈
   * @returns spanId，后续传给 end / error
   */
  start(name: string, context: string, input?: Record<string, unknown>): string {
    const parentId = this._stack.length > 0 ? this._stack[this._stack.length - 1].id : null;
    const span: TraceSpan = {
      id: nextSpanId(),
      parentId,
      name,
      context,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      input: input ? (sanitizeLogArg(input) as Record<string, unknown>) : null,
      output: null,
      error: null,
      children: [],
    };

    // 如果 root 为空且没有 parent，这是 root span
    if (!this._root && !parentId) {
      this._root = span;
    }

    // 挂载到父 span 的 children
    if (parentId) {
      const parent = this._spanMap.get(parentId);
      if (parent) {
        parent.children.push(span);
      }
    }

    this._spanMap.set(span.id, span);
    this._stack.push(span);
    return span.id;
  }

  /**
   * 结束当前调用 span，弹出调用栈，记录结果
   */
  end(spanId: string, output?: unknown): void {
    const span = this._spanMap.get(spanId);
    if (!span) {
      logger.debug(`[Tracer] end() 找不到 span: ${spanId}`);
      return;
    }
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.output = output !== undefined ? sanitizeLogArg(output) : null;

    // 从栈中弹出
    const idx = this._stack.findIndex(s => s.id === spanId);
    if (idx >= 0) {
      this._stack.splice(idx, 1);
    }
  }

  /**
   * 记录错误到当前 span，标记整个 trace 为有错误
   */
  error(spanId: string, error: unknown): void {
    const span = this._spanMap.get(spanId);
    if (!span) {
      logger.debug(`[Tracer] error() 找不到 span: ${spanId}`);
      return;
    }
    this._hasError = true;
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || '' : '';
    span.error = { message: msg, stack: stack.slice(0, 500) };
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
  }

  /**
   * 结束整个 trace 会话，生成报告
   */
  finish(): TraceReport {
    this._endedAt = Date.now();

    // 栈中还有未结束的 span，强制结束
    for (const span of this._stack) {
      if (span.endTime === null) {
        span.endTime = this._endedAt;
        span.durationMs = span.endTime - span.startTime;
      }
    }

    if (!this._root) {
      return {
        sessionId: this._sessionId,
        startedAt: this._startedAt,
        endedAt: this._endedAt,
        totalDurationMs: this._endedAt - this._startedAt,
        rootSpan: {
          id: 'empty', parentId: null, name: '(empty)', context: '-',
          startTime: this._startedAt, endTime: this._endedAt,
          durationMs: 0, input: null, output: null, error: null, children: [],
        },
        hasError: false,
        chainText: '[Trace empty]',
      };
    }

    const chainText = formatSpanTree(this._root).join('\n');

    // 如果有错误，自动 dump 到错误日志
    if (this._hasError) {
      logger.error(`[Tracer] ═══ 调用链追踪 (有错误) ═══\n` +
        `Session: ${this._sessionId}\n${chainText}`);
    } else {
      logger.info(`[Tracer] ─── 调用链追踪 ───\n` +
        `Session: ${this._sessionId}\n${chainText}`);
    }

    return {
      sessionId: this._sessionId,
      startedAt: this._startedAt,
      endedAt: this._endedAt,
      totalDurationMs: this._endedAt - this._startedAt,
      rootSpan: this._root,
      hasError: this._hasError,
      chainText,
    };
  }

  /**
   * 获取最新 trace（不结束会话）
   */
  getChainText(): string {
    if (!this._root) return '[No trace data]';
    return formatSpanTree(this._root).join('\n');
  }
}

// ---- 全局 Trace 存储 ----
// 保存最近 100 个完成的 trace，支持 API 查询

const MAX_TRACES = 100;
const _completedTraces: Map<string, TraceReport> = new Map();
const _activeTracers: Map<string, Tracer> = new Map();

/**
 * 创建或获取会话的 tracer
 */
export function getTracer(sessionId: string): Tracer {
  let t = _activeTracers.get(sessionId);
  if (!t) {
    t = new Tracer(sessionId);
    _activeTracers.set(sessionId, t);
    // 清理过多活跃 tracer
    if (_activeTracers.size > 20) {
      const first = _activeTracers.keys().next().value;
      if (first) _activeTracers.delete(first);
    }
  }
  return t;
}

/**
 * 完成 trace：从活跃列表移到已完成列表，清理过期
 */
export function finishTrace(sessionId: string): TraceReport | null {
  const t = _activeTracers.get(sessionId);
  if (!t) return null;
  const report = t.finish();
  _activeTracers.delete(sessionId);
  _completedTraces.set(sessionId, report);
  // 只保留最近 100 个
  if (_completedTraces.size > MAX_TRACES) {
    const keys = [..._completedTraces.keys()];
    for (let i = 0; i < keys.length - MAX_TRACES; i++) {
      _completedTraces.delete(keys[i]);
    }
  }
  return report;
}

/**
 * 获取最近的 trace 报告（按 sessionId 或取最新）
 */
export function getTraceReport(sessionId?: string): TraceReport | null {
  if (sessionId) {
    // 先查已完成
    const comp = _completedTraces.get(sessionId);
    if (comp) return comp;
    // 再查活跃中的
    const active = _activeTracers.get(sessionId);
    if (active) return active.finish();
    return null;
  }
  // 返回最新完成的
  const entries = [..._completedTraces.entries()];
  if (entries.length === 0) return null;
  return entries[entries.length - 1][1];
}

/**
 * 获取最近完成的 trace 列表（供 API 使用）
 */
export function getRecentTraces(limit = 20): { sessionId: string; hasError: boolean; durationMs: number; startedAt: string }[] {
  const entries = [..._completedTraces.entries()];
  return entries.slice(-limit).reverse().map(([id, r]) => ({
    sessionId: id,
    hasError: r.hasError,
    durationMs: r.totalDurationMs ?? 0,
    startedAt: new Date(r.startedAt).toISOString(),
  }));
}
