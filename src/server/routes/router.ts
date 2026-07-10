// 路由表核心 — 将分散的 if-else 路由替换为 Map 路由表
// 支持：精确匹配、前缀匹配、方法校验、参数提取

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── 类型定义 ───

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: string;                    // 完整 URL（含 query string）
  pathname: string;               // 不含 query string
  query: URLSearchParams;         // 解析后的 query 参数
  params: Record<string, string>; // 路径参数（前缀匹配中的 :param）
  body: any;                      // 已解析的请求体（POST/PUT）
  rawBody: string;                // 原始请求体字符串
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface RouteEntry {
  method: HttpMethod;
  pattern: string;                // 路径模式（支持 :param）
  handler: RouteHandler;
  isPrefix: boolean;              // true = 前缀匹配
  middleware?: RouteMiddleware[];
}

export type RouteMiddleware = (ctx: RouteContext, next: () => Promise<void>) => Promise<void>;

// ─── Router 类 ───

export class Router {
  private routes: RouteEntry[] = [];
  private exactMap: Map<string, Map<HttpMethod, RouteEntry>> = new Map();

  /** 注册路由 */
  register(
    method: HttpMethod,
    pattern: string,
    handler: RouteHandler,
    options: { prefix?: boolean; middleware?: RouteMiddleware[] } = {}
  ): void {
    const entry: RouteEntry = {
      method,
      pattern,
      handler,
      isPrefix: options.prefix ?? false,
      middleware: options.middleware,
    };

    // 精确匹配且无参数 → 用 Map 加速查找
    if (!pattern.includes(':') && !options.prefix) {
      if (!this.exactMap.has(pattern)) {
        this.exactMap.set(pattern, new Map());
      }
      this.exactMap.get(pattern)!.set(method, entry);
    } else {
      this.routes.push(entry);
    }
  }

  /** GET 快捷方法 */
  get(pattern: string, handler: RouteHandler, options?: { middleware?: RouteMiddleware[] }): void {
    this.register('GET', pattern, handler, options);
  }

  /** POST 快捷方法 */
  post(pattern: string, handler: RouteHandler, options?: { middleware?: RouteMiddleware[] }): void {
    this.register('POST', pattern, handler, options);
  }

  /** PUT 快捷方法 */
  put(pattern: string, handler: RouteHandler, options?: { middleware?: RouteMiddleware[] }): void {
    this.register('PUT', pattern, handler, options);
  }

  /** DELETE 快捷方法 */
  delete(pattern: string, handler: RouteHandler, options?: { middleware?: RouteMiddleware[] }): void {
    this.register('DELETE', pattern, handler, options);
  }

  /** 前缀匹配路由 */
  prefix(method: HttpMethod, prefix: string, handler: RouteHandler, options?: { middleware?: RouteMiddleware[] }): void {
    this.register(method, prefix, handler, { prefix: true, middleware: options?.middleware });
  }

  /** 查找匹配的路由 */
  async lookup(method: HttpMethod, pathname: string): Promise<{ entry: RouteEntry; params: Record<string, string> } | null> {
    // 1. 精确匹配（O(1) Map 查找）
    const methodMap = this.exactMap.get(pathname);
    if (methodMap) {
      const entry = methodMap.get(method);
      if (entry) {
        return { entry, params: {} };
      }
      // 路径匹配但方法不对 → 405 Method Not Allowed
      if (methodMap.size > 0) {
        return null; // 调用方可根据 methodMap 判断 405
      }
    }

    // 2. 前缀匹配和参数匹配（O(n) 线性扫描）
    for (const entry of this.routes) {
      if (entry.method !== method) continue;

      const { matched, params } = this.matchPattern(entry.pattern, pathname, entry.isPrefix);
      if (matched) {
        return { entry, params };
      }
    }

    return null;
  }

  /** 模式匹配 */
  private matchPattern(pattern: string, pathname: string, isPrefix: boolean): { matched: boolean; params: Record<string, string> } {
    const params: Record<string, string> = {};

    if (isPrefix) {
      // 前缀匹配
      if (pathname.startsWith(pattern)) {
        // 提取剩余部分作为参数（如 /api/logs/errors/123 → { rest: '123' }）
        const rest = pathname.slice(pattern.length).replace(/^\//, '');
        if (rest) params.rest = rest;
        return { matched: true, params };
      }
      return { matched: false, params };
    }

    // 参数匹配：/api/sessions/:id → /api/sessions/abc123
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);

    if (patternParts.length !== pathParts.length) {
      return { matched: false, params };
    }

    for (let i = 0; i < patternParts.length; i++) {
      const pp = patternParts[i];
      const pathPart = pathParts[i];

      if (pp.startsWith(':')) {
        params[pp.slice(1)] = decodeURIComponent(pathPart);
      } else if (pp !== pathPart) {
        return { matched: false, params };
      }
    }

    return { matched: true, params };
  }

  /** 执行路由处理器（含中间件） */
  async execute(entry: RouteEntry, ctx: RouteContext): Promise<void> {
    // 构建中间件链
    const middlewares = entry.middleware ?? [];
    let currentIndex = 0;

    const runMiddleware = async (): Promise<void> => {
      if (currentIndex < middlewares.length) {
        const mw = middlewares[currentIndex++];
        await mw(ctx, runMiddleware);
      } else {
        await entry.handler(ctx);
      }
    };

    await runMiddleware();
  }

  /** 获取所有已注册路由（用于调试和文档生成） */
  list(): Array<{ method: string; pattern: string; isPrefix: boolean }> {
    const result: Array<{ method: string; pattern: string; isPrefix: boolean }> = [];
    for (const [path, methodMap] of this.exactMap) {
      for (const [method, entry] of methodMap) {
        result.push({ method, pattern: path, isPrefix: false });
      }
    }
    for (const entry of this.routes) {
      result.push({ method: entry.method, pattern: entry.pattern, isPrefix: entry.isPrefix });
    }
    return result.sort((a, b) => a.pattern.localeCompare(b.pattern));
  }
}

// ─── 辅助函数 ───

/** 读取请求体 */
export async function readBodyStream(req: http.IncomingMessage, maxBytes: number = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        aborted = true;
        reject(new Error(`Body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err: Error) => {
      if (aborted) return;
      reject(err);
    });
  });
}

/** 解析 JSON 请求体 */
export async function readJsonBody(req: http.IncomingMessage, maxBytes: number = 1_000_000): Promise<any> {
  const raw = await readBodyStream(req, maxBytes);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/** 发送 JSON 响应 */
export function sendJson(res: http.ServerResponse, data: any, status: number = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** 发送错误响应 */
export function sendError(res: http.ServerResponse, message: string, status: number = 500): void {
  sendJson(res, { error: message }, status);
}

/** 解析 URL */
export function parseUrl(rawUrl: string): { pathname: string; query: URLSearchParams } {
  const parsed = new URL(rawUrl, 'http://localhost');
  return {
    pathname: parsed.pathname,
    query: parsed.searchParams,
  };
}

/** 从路由表创建路由上下文 */
export async function createRouteContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string> = {}
): Promise<RouteContext> {
  const rawUrl = req.url || '/';
  const { pathname, query } = parseUrl(rawUrl);

  let body: any = null;
  let rawBody = '';

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    rawBody = await readBodyStream(req);
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { /* 非 JSON，保留 rawBody */ }
    }
  }

  return {
    req,
    res,
    url: rawUrl,
    pathname,
    query,
    params,
    body,
    rawBody,
  };
}
