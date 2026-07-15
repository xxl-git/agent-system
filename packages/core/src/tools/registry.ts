/**
 * =============================================================================
 * 工具注册表 — Agent System 工具执行层
 * ===========================================================

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

==================
 *
 * 职责：
 * - 统一工具执行入口（call(name, args)）
 * - 熔断器集成：执行前检查、执行后记录
 * - 统一错误处理：超时捕获、权限错误、路径安全
 *
 * 集成点：
 * - CircuitBreaker：每个工具独立的熔断器状态
 * - HealthMonitor：工具执行统计
 * - AuditLog：工具调用审计
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec as execSync } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger';

const execAsync = promisify(execSync);

// ─── 工具定义 ────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  /** 工具描述，用于告诉 LLM 何时使用 */
  schema: Record<string, unknown>;
  /** 该工具是否启用（可通过熔断关闭） */
  enabled: boolean;
  /** 工具执行超时 (ms) */
  timeoutMs: number;
  /** 是否需要用户确认 */
  requiresConfirm: boolean;
}

export interface ToolCallResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  toolName: string;
}

// 内置工具注册表
const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  write_file: {
    name: 'write_file',
    description: '创建或覆盖文件内容（UTF-8）',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对于 D:\\QClaw_Workspace）' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    enabled: true,
    timeoutMs: 10000,
    requiresConfirm: false,
  },
  read_file: {
    name: 'read_file',
    description: '读取文件内容（UTF-8）',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        maxLines: { type: 'number', description: '最多读取行数（默认全部）', default: 0 },
      },
      required: ['path'],
    },
    enabled: true,
    timeoutMs: 5000,
    requiresConfirm: false,
  },
  web_search: {
    name: 'web_search',
    description: '搜索网络获取最新信息',
    schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量', default: 5 },
      },
      required: ['keyword'],
    },
    enabled: true,
    timeoutMs: 30000,
    requiresConfirm: false,
  },
  exec: {
    name: 'exec',
    description: '执行 Shell 命令（仅 Windows PowerShell）',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['command'],
    },
    enabled: true,
    timeoutMs: 60000,
    requiresConfirm: true, // 需要确认的危险操作
  },
  list_dir: {
    name: 'list_dir',
    description: '列出目录内容',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
      },
      required: ['path'],
    },
    enabled: true,
    timeoutMs: 5000,
    requiresConfirm: false,
  },
};

// ─── 熔断器引用（由 AgentCore 注入） ──────────────────────────────────────

let _circuitBreaker: any = null;

export function setCircuitBreaker(cb: any): void {
  _circuitBreaker = cb;
}

function canUseTool(toolName: string): boolean {
  if (!_circuitBreaker) return true; // 无熔断器时默认可用
  return _circuitBreaker.canUseTool(toolName);
}

function recordToolSuccess(toolName: string): void {
  _circuitBreaker?.toolSuccess(toolName);
}

function recordToolFailure(toolName: string, error?: string): void {
  _circuitBreaker?.toolFailure(toolName, error);
}

// ─── 工具执行器 ────────────────────────────────────────────────────────────

async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具执行超时 (${timeoutMs}ms)`)), timeoutMs);
    fn()
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** 安全路径：防止路径穿越攻击 */
function safePath(inputPath: string): string {
  const workspace = 'D:\\QClaw_Workspace';
  let resolved: string;
  try {
    resolved = path.resolve(inputPath);
  } catch {
    throw new Error(`非法路径: ${inputPath}`);
  }

  // 禁止访问 workspace 之外的文件
  if (!resolved.startsWith(workspace) && !resolved.startsWith('D:\\')) {
    throw new Error(`禁止访问 workspace 外部路径: ${resolved}`);
  }

  // 禁止访问系统关键路径
  const forbidden = ['C:\\Windows\\System32', 'C:\\Windows\\SysWOW64', 'C:\\Program Files'];
  for (const forb of forbidden) {
    if (resolved.startsWith(forb)) {
      throw new Error(`禁止访问系统目录: ${forb}`);
    }
  }

  return resolved;
}

// ─── 工具实现 ──────────────────────────────────────────────────────────────

async function runWriteFile(args: any): Promise<string> {
  const filePath = safePath(args.path);
  const content = args.content ?? '';
  const dir = path.dirname(filePath);

  // 确保目录存在
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 写入文件（UTF-8 with BOM for compatibility）
  const bom = '\uFEFF';
  const finalContent = typeof content === 'string' ? bom + content : String(content);
  fs.writeFileSync(filePath, finalContent, 'utf-8');

  return `文件已写入: ${filePath} (${fs.statSync(filePath).size} bytes)`;
}

async function runReadFile(args: any): Promise<string> {
  const filePath = safePath(args.path);
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`路径是目录而非文件: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  // 移除 UTF-8 BOM（如果存在）
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const maxLines = args.maxLines ?? 0;
  if (maxLines > 0) {
    const lines = content.split('\n');
    content = lines.slice(0, maxLines).join('\n') + `\n... (共 ${lines.length} 行，显示前 ${maxLines} 行)`;
  }

  return content;
}

async function runWebSearch(args: any): Promise<string> {
  const keyword = args.keyword ?? '';
  const count = args.count ?? 5;

  if (!keyword.trim()) {
    throw new Error('搜索关键词不能为空');
  }

  // 使用 PowerShell 的 Invoke-WebRequest（模拟，简单实现）
  // 实际项目中应该调用 Bing/Google API
  try {
    const encoded = encodeURIComponent(keyword);
    const curlCmd = `powershell -Command "try { (Invoke-WebRequest -Uri 'https://cn.bing.com/search?q=${encoded}&count=${count}' -TimeoutSec 15 -UserAgent 'Mozilla/5.0').Content.Substring(0,3000) } catch { '搜索失败: ' + $_.Exception.Message }"`;

    const { stdout } = await execAsync(curlCmd, { timeout: 20000, cwd: 'D:\\' });
    const clean = stdout.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return clean.slice(0, 2000) || `搜索结果（关键词: ${keyword}）`;
  } catch (err: unknown) {
    throw new Error(`搜索失败: ${errorMessage(err) ?? '网络错误'}`);
  }
}

async function runExec(args: any): Promise<string> {
  const command = args.command ?? '';
  const cwd = args.cwd ? safePath(args.cwd) : 'D:\\QClaw_Workspace';

  if (!command.trim()) {
    throw new Error('命令不能为空');
  }

  // 安全过滤：禁止危险命令
  const dangerous = [/^del\s/i, /^rm\s/i, /^format\s/i, /^diskpart\s/i, /^cipher\s/i];
  for (const pattern of dangerous) {
    if (pattern.test(command.trim())) {
      throw new Error(`禁止执行危险命令: ${command.trim().slice(0, 20)}`);
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60000,
      maxBuffer: 1024 * 1024, // 1MB
      shell: 'powershell',
    });
    const out = stdout || stderr || '(命令执行完成，无输出)';
    return out.slice(0, 5000);
  } catch (err: unknown) {
    throw new Error(`命令执行失败: ${errorMessage(err) ?? '未知错误'}`);
  }
}

async function runListDir(args: any): Promise<string> {
  const dirPath = safePath(args.path ?? 'D:\\QClaw_Workspace');
  if (!fs.existsSync(dirPath)) {
    throw new Error(`目录不存在: ${dirPath}`);
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`路径不是目录: ${dirPath}`);
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = entries.slice(0, 100).map((e) => {
    const prefix = e.isDirectory() ? '[DIR] ' : '[FILE] ';
    const size = e.isFile() ? ` (${fs.statSync(path.join(dirPath, e.name)).size}b)` : '';
    return prefix + e.name + size;
  });

  return lines.join('\n') + `\n(${entries.length} 项${entries.length > 100 ? '，显示前100项' : ''})`;
}

// ─── 工具注册表主类 ────────────────────────────────────────────────────────

class ToolRegistry {
  private definitions: Record<string, ToolDefinition> = { ...TOOL_DEFINITIONS };
  private executors: Record<string, (args: any) => Promise<string>> = {
    write_file: runWriteFile,
    read_file: runReadFile,
    web_search: runWebSearch,
    exec: runExec,
    list_dir: runListDir,
  };

  /** 注册新工具（用于动态扩展） */
  register(definition: ToolDefinition, executor: (args: any) => Promise<string>): void {
    this.definitions[definition.name] = definition;
    this.executors[definition.name] = executor;
    logger.debug(`[ToolRegistry] 注册工具: ${definition.name}`);
  }

  /** 禁用工具（熔断触发后） */
  disable(name: string): void {
    if (this.definitions[name]) {
      this.definitions[name].enabled = false;
      logger.warn(`[ToolRegistry] 工具已禁用: ${name}`);
    }
  }

  /** 启用工具 */
  enable(name: string): void {
    if (this.definitions[name]) {
      this.definitions[name].enabled = true;
    }
  }

  /** 获取工具定义 */
  getDefinition(name: string): ToolDefinition | null {
    return this.definitions[name] ?? null;
  }

  /** 列出所有工具 */
  listTools(): ToolDefinition[] {
    return Object.values(this.definitions);
  }

  /** 检查工具是否可用（定义存在 + 已启用 + 熔断器关闭） */
  isAvailable(name: string): { available: boolean; reason?: string } {
    const def = this.definitions[name];
    if (!def) return { available: false, reason: '工具不存在' };
    if (!def.enabled) return { available: false, reason: '工具已禁用' };
    if (!canUseTool(name)) return { available: false, reason: '熔断器已触发，请稍后重试' };
    return { available: true };
  }

  /** 执行工具（主入口） */
  async call(toolName: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const t0 = Date.now();
    const availability = this.isAvailable(toolName);

    // 熔断器检查
    if (!availability.available) {
      recordToolFailure(toolName, availability.reason);
      return {
        success: false,
        output: '',
        error: `⛔ 工具不可用: ${availability.reason}`,
        durationMs: Date.now() - t0,
        toolName,
      };
    }

    const executor = this.executors[toolName];
    if (!executor) {
      return {
        success: false,
        output: '',
        error: `未知工具: ${toolName}`,
        durationMs: Date.now() - t0,
        toolName,
      };
    }

    try {
      const output = await executeWithTimeout(
        () => executor(args),
        this.definitions[toolName].timeoutMs,
      );

      recordToolSuccess(toolName);

      logger.debug(`[ToolRegistry] ✓ ${toolName} (${Date.now() - t0}ms)`);
      return {
        success: true,
        output,
        durationMs: Date.now() - t0,
        toolName,
      };
    } catch (err: unknown) {
      recordToolFailure(toolName, errorMessage(err));

      // 连续失败 → 触发熔断
      const cbState = _circuitBreaker?.tool(toolName);
      if (cbState?.state === 'OPEN') {
        this.disable(toolName);
        logger.warn(`[ToolRegistry] 🔴 工具 ${toolName} 已熔断并禁用`);
      }

      const msg = errorMessage(err) ?? '未知错误';
      logger.warn(`[ToolRegistry] ✗ ${toolName}: ${msg}`);

      return {
        success: false,
        output: '',
        error: msg,
        durationMs: Date.now() - t0,
        toolName,
      };
    }
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────────────────

let _instance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!_instance) {
    _instance = new ToolRegistry();
  }
  return _instance;
}

// 兼容命名（agent-core.ts 使用 toolRegistry）
export const toolRegistry = getToolRegistry();

// 兼容 ES6 default export
export default toolRegistry;
