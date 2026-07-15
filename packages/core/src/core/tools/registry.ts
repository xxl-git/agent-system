// 工具注册表
import type { ToolDef, ToolResult, ToolCallRecord } from './types';



/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();
  private callHistory: ToolCallRecord[] = [];

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolDescriptions(): string {
    return this.list().map(t => {
      const params = t.parameters
        .filter(p => p.required)
        .map(p => `${p.name}: ${p.type}`)
        .join(', ');
      return `- ${t.name}(${params}): ${t.description}`;
    }).join('\n');
  }

  async call(name: string, args: Record<string, string>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: '', error: `未知工具: ${name}`, durationMs: 0 };
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await tool.execute(args);
    } catch (err: unknown) {
      result = { success: false, output: '', error: errorMessage(err), durationMs: Date.now() - start };
    }

    const record: ToolCallRecord = {
      tool: name,
      args,
      result,
      timestamp: new Date().toISOString(),
    };
    this.callHistory.push(record);

    return result;
  }

  getCallHistory(): ToolCallRecord[] {
    return this.callHistory;
  }
}

export const toolRegistry = new ToolRegistry();
