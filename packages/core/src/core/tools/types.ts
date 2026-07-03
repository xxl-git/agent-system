// 工具系统类型定义
export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParamDef[];
  execute: (args: Record<string, string>) => Promise<ToolResult>;
}

export interface ToolParamDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, string>;
  result: ToolResult;
  timestamp: string;
}
