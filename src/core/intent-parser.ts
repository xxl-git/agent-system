// 意图解析器 — 用模型分析用户消息，输出结构化意图
// v4: 支持 PromptRegistry（提示词模板化，不再硬编码）
import type { ChatMessage } from '../models/adapters/lmstudio';
import { LMStudioAdapter } from '../models/adapters/lmstudio';
import { getLLMRouter, type LLMRouter } from '../llm/llm-router';
import { getPromptRegistry } from '../prompts/registry';

export interface ParsedIntent {
  type: 'chat' | 'task' | 'query' | 'command' | 'unknown';
  summary: string;             // 一句话总结用户想做什么
  entities: string[];          // 提取的实体（文件名、路径、人名等）
  confidence: number;          // 0-1
  needsClarification: boolean; // 是否信息不足
  missingInfo: string[];       // 缺失的信息项
}

export class IntentParser {
  private adapter: LMStudioAdapter | any; // SmartAdapter 兼容
  private useRouter = false;

  constructor(adapter?: LMStudioAdapter | any) {
    this.adapter = adapter || new LMStudioAdapter();
    try { getLLMRouter(); this.useRouter = true; } catch { this.useRouter = false; }
  }

  async parse(userMessage: string): Promise<ParsedIntent> {
    // 先用规则快速判断
    const quickResult = quickParse(userMessage);
    if (quickResult.confidence >= 0.9) {
      return quickResult;
    }

    // 用模型深度解析
    return this.modelParse(userMessage);
  }

  private async modelParse(userMessage: string): Promise<ParsedIntent> {
    // Phase 2: 从 PromptRegistry 获取意图解析提示词
    const registry = getPromptRegistry();
    const tpl = registry.get('intent.parse');
    const systemContent = tpl.system || `你是一个意图分析器。分析用户消息，用 JSON 输出：
{
  "type": "chat|task|query|command",
  "summary": "用中文一句话总结用户意图",
  "entities": ["实体1", "实体2"],
  "confidence": 0.8,
  "needsClarification": false,
  "missingInfo": []
}
只输出 JSON，不要额外文字。`;

    const sysPrompt: ChatMessage = { role: 'system', content: systemContent };
    const userMsg: ChatMessage = { role: 'user', content: userMessage };

    try {
      const res = this.useRouter
        ? await getLLMRouter().call({ taskType: 'intent', messages: [sysPrompt, userMsg] })
        : await this.adapter.chat([sysPrompt, userMsg]);
      const content = res.choices?.[0]?.message?.content || '';
      // 提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as ParsedIntent;
      }
    } catch (e) {
      // 模型调用失败，降级为规则解析
    }

    return quickParse(userMessage);
  }
}

function quickParse(userMessage: string): ParsedIntent {
  const msg = userMessage.trim();

  // 命令检测
  if (msg.startsWith('/')) {
    return {
      type: 'command',
      summary: `执行命令: ${msg}`,
      entities: [msg],
      confidence: 0.95,
      needsClarification: false,
      missingInfo: [],
    };
  }

  // 闲聊检测 (去掉 \b 以支持中文)
  const chatPatterns = [
    /^(你好|hi|hello|嗨|哈喽|早|晚安|bye|再见|谢谢|thank|ok|好|嗯|哦|知道了)/i,
    /^(哈哈|嘿嘿|嘻嘻)/,
    /^你是谁/,
    /^介绍/,
    /有什么(建议|功能|能力)/,
    /能(做什么|干嘛|帮我)/,
    /今天/,
    /最近/,
    /怎么(样|用)/,
    /推荐/,
    /聊聊/,
  ];
  for (const p of chatPatterns) {
    if (p.test(msg)) {
      return {
        type: 'chat',
        summary: '闲聊',
        entities: [],
        confidence: 0.9,
        needsClarification: false,
        missingInfo: [],
      };
    }
  }

  // 极短消息通常是闲聊 (< 5 字)
  if (msg.length < 5) {
    return {
      type: 'chat',
      summary: '简短消息',
      entities: [],
      confidence: 0.7,
      needsClarification: false,
      missingInfo: [],
    };
  }

  // 任务检测（包含动作词）
  const taskWords = ['帮我', '创建', '生成', '写', '编写', '实现', '开发', '安装', '配置', '设置', '运行', '启动', '部署', '修改', '修复', '删除', '下载', '编译', '测试', '搜索', '查找'];
  const isTask = taskWords.some(w => msg.includes(w));
  if (isTask) {
    return {
      type: 'task',
      summary: msg.length > 50 ? msg.slice(0, 50) + '...' : msg,
      entities: extractEntities(msg),
      confidence: 0.7,
      needsClarification: msg.length < 10,
      missingInfo: msg.length < 10 ? ['任务描述过于简短，需要更多信息'] : [],
    };
  }

  // 查询检测
  const queryWords = ['什么', '怎么', '如何', '为什么', '哪个', '多少', '查', '显示', '列出', '解释'];
  const isQuery = queryWords.some(w => msg.includes(w));
  if (isQuery) {
    return {
      type: 'query',
      summary: msg.length > 50 ? msg.slice(0, 50) + '...' : msg,
      entities: extractEntities(msg),
      confidence: 0.7,
      needsClarification: false,
      missingInfo: [],
    };
  }

  return {
    type: 'unknown',
    summary: msg.length > 50 ? msg.slice(0, 50) + '...' : msg,
    entities: extractEntities(msg),
    confidence: 0.3,
    needsClarification: msg.length < 5,
    missingInfo: msg.length < 5 ? ['消息过短，无法判断意图'] : [],
  };
}

function extractEntities(text: string): string[] {
  const entities: string[] = [];
  // 路径检测
  const pathMatch = text.match(/([A-Za-z]:\\[^\s,，。]+|[~/][^\s,，。]+)/g);
  if (pathMatch) entities.push(...pathMatch);
  // URL 检测
  const urlMatch = text.match(/https?:\/\/[^\s,，。]+/g);
  if (urlMatch) entities.push(...urlMatch);
  // 文件名检测
  const fileMatch = text.match(/[\w-]+\.[a-z]{2,4}/g);
  if (fileMatch) entities.push(...fileMatch);

  return [...new Set(entities)];
}
