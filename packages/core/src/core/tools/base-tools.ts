// 内置基础工具：exec, write_file, read_file, web_search
import type { ToolDef } from './types';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, mkdir } from 'fs/promises';

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 从 unknown 错误中获取 stdout/stderr (child_process exec error) */
function execErrorOutput(err: unknown): { stdout: string; stderr: string } {
  if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
    return { stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
  return { stdout: '', stderr: '' };
}
import { existsSync } from 'fs';
import * as path from 'path';

const execAsync = promisify(cpExec);

/** 允许的根目录（只允许在项目目录下操作）*/
const ALLOWED_ROOT = path.resolve(process.cwd());

/**
 * 路径安全检查：防止路径穿越攻击
 * 解析后检查是否在允许的根目录下
 */
function safePath(requestedPath: string): string | null {
  if (!requestedPath || typeof requestedPath !== 'string') return null;
  try {
    // 防止空字节注入
    if (requestedPath.includes('\0')) return null;
    const resolved = path.resolve(ALLOWED_ROOT, requestedPath);
    // 路径必须在允许根目录下（不能逃逸到上级）
    if (!resolved.startsWith(ALLOWED_ROOT)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** 检查危险命令（增强版）*/
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//i,           // rm -rf /
  /rm\s+-rf\s+\*/i,           // rm -rf *
  /del\s+\/[sfq]/i,            // del /f/s/q
  /shutdown/i,
  /reboot/i,
  /mkfs/i,
  /dd\s+if=/i,
  /curl\s+.*\|\s*bash/i,      // curl ... | bash
  /wget\s+.*\|\s*bash/i,     // wget ... | bash
  /bash\s+-i/i,                // bash -i (interactive shell)
  /sh\s+-i/i,                  // sh -i
  /nc\s+-[el]/i,              // nc -e/-l (netcat reverse shell)
  /ncat\s+-[el]/i,            // ncat reverse shell
  /python\s+.*-c\s+.*import/i, // python -c 'import'
  /php\s+.*-r\s+/i,          // php -r
  /ruby\s+.*-e\s+/i,         // ruby -e
  /perl\s+.*-e\s+/i,         // perl -e
  /eval\s*\(/i,              // eval (
  /base64\s+-d/i,             // base64 -d
  /chmod\s+[0-7][0-7][0-7]/i, // chmod 777 etc
  /wmic\s+os/i,               // WMIC OS
  /certutil\s+.*urlcache/i,   // certutil download
  /bitsadmin/i,                // BITS download
  /mshta\s+http/i,            // mshta download
  /reg\s+(add|delete)/i,      // registry modification
  /runas\s+/i,               // runas
];

function isDangerousCommand(command: string): boolean {
  const lower = command.toLowerCase();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

/** 执行命令（沙箱限制：工作目录固定，危险命令拒绝，增强版检查） */
export const execTool: ToolDef = {
  name: 'exec',
  description: '执行系统命令并返回输出（仅限项目目录，禁止危险命令）',
  parameters: [
    { name: 'command', type: 'string', description: '要执行的命令', required: true },
    { name: 'workdir', type: 'string', description: '工作目录（忽略，固定为项目目录）', required: false },
  ],
  async execute(args) {
    const { command } = args;
    const start = Date.now();

    // 增强版危险命令检查
    if (isDangerousCommand(command)) {
      return {
        success: false,
        output: '',
        error: '被拒绝：危险命令',
        durationMs: Date.now() - start,
      };
    }

    // 工作目录固定为项目根目录（忽略用户传入的 workdir）
    const safeWorkdir = ALLOWED_ROOT;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: safeWorkdir,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return {
        success: true,
        output: stdout || stderr || '(无输出)',
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: execErrorOutput(err).stdout, error: execErrorOutput(err).stderr || errorMessage(err),
        durationMs: Date.now() - start,
      };
    }
  },
};

/** 写入文件（自动建目录，UTF-8，路径安全限制） */
export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: '写入文件内容，自动创建父目录，使用 UTF-8 编码（限制在项目目录内）',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'content', type: 'string', description: '文件内容', required: true },
  ],
  async execute(args) {
    const { path: filePath, content } = args;
    const start = Date.now();

    const safe = safePath(filePath);
    if (!safe) {
      return {
        success: false,
        output: '',
        error: '路径无效或超出允许范围（仅限项目目录）',
        durationMs: Date.now() - start,
      };
    }

    try {
      const dir = path.dirname(safe);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(safe, content, 'utf-8');
      return {
        success: true,
        output: `文件已写入: ${safe} (${content.length} 字节)`,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return { success: false, output: '', error: errorMessage(err), durationMs: Date.now() - start };
    }
  },
};

/** 读取文件（路径安全限制） */
export const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取文件内容（限制在项目目录内）',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
  ],
  async execute(args) {
    const { path: filePath } = args;
    const start = Date.now();

    const safe = safePath(filePath);
    if (!safe) {
      return {
        success: false,
        output: '',
        error: '路径无效或超出允许范围（仅限项目目录）',
        durationMs: Date.now() - start,
      };
    }

    try {
      const content = await readFile(safe, 'utf-8');
      return {
        success: true,
        output: content.length > 5000
          ? content.slice(0, 5000) + `\n...(截断，共 ${content.length} 字)`
          : content,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return { success: false, output: '', error: errorMessage(err), durationMs: Date.now() - start };
    }
  },
};

/** 搜索 web */
export const webSearchTool: ToolDef = {
  name: 'web_search',
  description: '搜索网络获取最新信息',
  parameters: [
    { name: 'keyword', type: 'string', description: '搜索关键词', required: true },
  ],
  async execute(args) {
    const { keyword } = args;
    const start = Date.now();

    try {
      // 使用 OpenClaw 的 web_search 能力（如果可用）
      // 降级方案：直接 fetch DuckDuckGo HTML
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // 简单提取结果片段
      const snippets = html.match(/class="result__snippet">([^<]+)/g);
      if (!snippets || snippets.length === 0) {
        return { success: true, output: '未找到结果', durationMs: Date.now() - start };
      }

      const output = snippets
        .slice(0, 5)
        .map((s, i) => `${i + 1}. ${s.replace(/class="result__snippet">/, '').replace(/<[^>]+>/g, '')}`)
        .join('\n');

      return { success: true, output, durationMs: Date.now() - start };
    } catch (err: unknown) {
      return { success: false, output: '', error: errorMessage(err), durationMs: Date.now() - start };
    }
  },
};

/** 注册所有内置工具 */
export function registerBaseTools(registry: { register: (t: ToolDef) => void }): void {
  registry.register(execTool);
  registry.register(writeFileTool);
  registry.register(readFileTool);
  registry.register(webSearchTool);
}
