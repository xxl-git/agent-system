// Built-in tools: exec, write_file, read_file, web_search
import type { ToolDef } from './types';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';

const execAsync = promisify(cpExec);

/** 执行命令（危险命令拒绝） */
export const execTool: ToolDef = {
  name: 'exec',
  description: '执行系统命令并返回输出',
  parameters: [
    { name: 'command', type: 'string', description: '要执行的命令', required: true },
    { name: 'workdir', type: 'string', description: '工作目录', required: false },
  ],
  async execute(args) {
    const { command, workdir = process.cwd() } = args;
    const start = Date.now();

    const dangerous = ['rm -rf /', 'del /f /s', 'shutdown', 'reboot', 'mkfs', 'dd if='];
    if (dangerous.some(d => command.toLowerCase().includes(d))) {
      return { success: false, output: '', error: '被拒绝：危险命令', durationMs: Date.now() - start };
    }

    try {
      const { stdout, stderr } = await execAsync(command, { cwd: workdir, timeout: 30000, maxBuffer: 1024 * 1024 });
      return { success: true, output: stdout || stderr || '(无输出)', durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, output: err.stdout || '', error: err.stderr || err.message, durationMs: Date.now() - start };
    }
  },
};

/** 写入文件（UTF-8，自动建目录） */
export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: '写入文件内容，自动创建父目录，使用 UTF-8 编码',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'content', type: 'string', description: '文件内容', required: true },
  ],
  async execute(args) {
    const { path: filePath, content } = args;
    const start = Date.now();
    try {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        await import('fs/promises').then(m => m.mkdir(dir, { recursive: true }));
      }
      await writeFile(filePath, content, 'utf-8');
      return { success: true, output: `文件已写入: ${filePath} (${content.length} 字节)`, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, output: '', error: err.message, durationMs: Date.now() - start };
    }
  },
};

/** 读取文件 */
export const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取文件内容',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
  ],
  async execute(args) {
    const { path: filePath } = args;
    const start = Date.now();
    try {
      const content = await readFile(filePath, 'utf-8');
      return {
        success: true,
        output: content.length > 5000 ? content.slice(0, 5000) + `\n...(截断，共 ${content.length} 字)` : content,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { success: false, output: '', error: err.message, durationMs: Date.now() - start };
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
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const snippets = html.match(/class="result__snippet">([^<]+)/g);
      if (!snippets || snippets.length === 0) return { success: true, output: '未找到结果', durationMs: Date.now() - start };
      const output = snippets.slice(0, 5).map((s, i) =>
        `${i + 1}. ${s.replace(/class="result__snippet">/, '').replace(/<[^>]+>/g, '')}`).join('\n');
      return { success: true, output, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, output: '', error: err.message, durationMs: Date.now() - start };
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
