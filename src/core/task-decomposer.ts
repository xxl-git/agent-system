// 任务分解引擎 — 把用户任务拆成子任务 DAG
// v2: 支持 PromptRegistry（提示词模板化）
import type { ChatMessage } from '../models/adapters/lmstudio';
import { LMStudioAdapter } from '../models/adapters/lmstudio';
import { getLLMRouter } from '../llm/llm-router';
import { getPromptRegistry } from '../prompts/registry';

export interface SubTask {
  id: string;
  title: string;
  description: string;
  tool?: string;              // 使用的工具名
  toolArgs?: Record<string, string>; // 工具参数
  dependsOn: string[];        // 依赖的子任务 ID
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: { success: boolean; output: string; error?: string };
  estimatedMinutes: number;
}

export interface TaskDAG {
  originalRequest: string;
  tasks: SubTask[];
  parallelGroups: string[][]; // 可并行的任务组
}

export class TaskDecomposer {
  private adapter: LMStudioAdapter;
  private useRouter = false;

  constructor() {
    this.adapter = new LMStudioAdapter();
    try { getLLMRouter(); this.useRouter = true; } catch { this.useRouter = false; }
  }

  async decompose(userRequest: string, availableTools: string[]): Promise<TaskDAG> {
    // 简单任务直接用规则分解
    const simple = simpleDecompose(userRequest, availableTools);
    if (simple) return simple;

    // 复杂任务用模型分解
    return this.modelDecompose(userRequest, availableTools);
  }

  private async modelDecompose(userRequest: string, availableTools: string[]): Promise<TaskDAG> {
    // Phase 2: 从 PromptRegistry 获取任务分解提示词（支持变量插值）
    const registry = getPromptRegistry();
    const tpl = registry.get('task.decompose', { availableTools: availableTools.join(', ') });
    const systemContent = tpl.system || `你是一个任务分解器。将用户请求拆解成子任务 DAG，输出 JSON。可用工具: ${availableTools.join(', ')}。只输出 JSON。`;

    const sysPrompt: ChatMessage = { role: 'system', content: systemContent };
    const userMsg: ChatMessage = { role: 'user', content: userRequest };

    try {
      const res = this.useRouter
        ? await getLLMRouter().call({ taskType: 'decompose', messages: [sysPrompt, userMsg] })
        : await this.adapter.chat([sysPrompt, userMsg]);
      const content = res.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          originalRequest: userRequest,
          tasks: parsed.tasks.map((t: any) => ({
            ...t,
            status: 'pending' as const,
            dependsOn: t.dependsOn || [],
          })),
          parallelGroups: parsed.parallelGroups || [parsed.tasks.map((t: any) => t.id)],
        };
      }
    } catch (e) {
      // 降级：当成单个任务
    }

    return {
      originalRequest: userRequest,
      tasks: [{
        id: '1',
        title: userRequest.slice(0, 80),
        description: userRequest,
        dependsOn: [],
        status: 'pending',
        estimatedMinutes: 1,
      }],
      parallelGroups: [['1']],
    };
  }
}

/** 简单任务规则分解 */
function simpleDecompose(userRequest: string, tools: string[]): TaskDAG | null {
  const req = userRequest.trim();

  // "帮我创建 X 文件，内容是 Y"
  const createFileMatch = req.match(/(?:帮[我你]?)?(?:创建|生成|写|编写)[一个]?[文件]?\s*[：:]?\s*(.+?)(?:\s*[,，]\s*内容[是为：:]\s*(.+))?$/);
  if (createFileMatch && tools.includes('write_file')) {
    const filePath = createFileMatch[1].trim();
    const content = createFileMatch[2]?.trim() || '';
    return {
      originalRequest: req,
      tasks: [{
        id: '1',
        title: `创建文件: ${filePath}`,
        description: `写入内容到 ${filePath}`,
        tool: 'write_file',
        toolArgs: { path: filePath, content },
        dependsOn: [],
        status: 'pending',
        estimatedMinutes: 1,
      }],
      parallelGroups: [['1']],
    };
  }

  // "帮我读取 X 文件"
  const readFileMatch = req.match(/(?:帮[我你]?)?(?:读|读取|打开|查看|显示)\s*(.+\.\w+)/);
  if (readFileMatch && tools.includes('read_file')) {
    const filePath = readFileMatch[1].trim();
    return {
      originalRequest: req,
      tasks: [{
        id: '1',
        title: `读取文件: ${filePath}`,
        description: `读取 ${filePath} 的内容`,
        tool: 'read_file',
        toolArgs: { path: filePath },
        dependsOn: [],
        status: 'pending',
        estimatedMinutes: 1,
      }],
      parallelGroups: [['1']],
    };
  }

  // "帮我搜索 X"
  const searchMatch = req.match(/(?:帮[我你]?)?(?:搜索|查[询找]?|找[一下]?)\s*(.+)/);
  if (searchMatch && tools.includes('web_search')) {
    return {
      originalRequest: req,
      tasks: [{
        id: '1',
        title: `搜索: ${searchMatch[1].slice(0, 50)}`,
        description: `搜索关键词: ${searchMatch[1]}`,
        tool: 'web_search',
        toolArgs: { keyword: searchMatch[1].trim() },
        dependsOn: [],
        status: 'pending',
        estimatedMinutes: 1,
      }],
      parallelGroups: [['1']],
    };
  }

  // 无法简单匹配
  return null;
}
