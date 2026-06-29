// LLM Client Interface — 解耦 ExperienceExtractor 对具体 LLM 实现的依赖
// 这样 experience 包可以独立构建和测试

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMClient {
  /** 调用 LLM，返回文本响应 */
  call(messages: ChatMessage[]): Promise<string>;
}

export interface PromptRegistry {
  /** 获取提示词模板，支持变量插值 */
  get(templateId: string, variables?: Record<string, string>): { system?: string; user?: string };
}

/** 默认实现：使用根项目的 LLMRouter */
export class DefaultLLMClient implements LLMClient {
  async call(messages: ChatMessage[]): Promise<string> {
    // 延迟导入，避免编译时依赖
    const { getLLMRouter } = require('../../../src/llm/llm-router');
    const router = getLLMRouter();
    const response = await router.call({ taskType: 'chat', messages });
    return response.content;
  }
}

/** 默认实现：使用根项目的 PromptRegistry */
export class DefaultPromptRegistry implements PromptRegistry {
  get(templateId: string, variables?: Record<string, string>): { system?: string; user?: string } {
    // 延迟导入
    const { getPromptRegistry } = require('../../../src/prompts/registry');
    const registry = getPromptRegistry();
    return registry.get(templateId, variables);
  }
}
