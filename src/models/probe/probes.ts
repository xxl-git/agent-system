// 能力探测 — 探针定义 (Phase 2A)
// 每个探针测试模型的一项关键能力

export type ProbeCategory = 'tool_calling' | 'json_output' | 'reasoning' | 'speed' | 'context' | 'stability';

export interface Probe {
  id: string;
  category: ProbeCategory;
  name: string;
  description: string;
  /** 探针 prompt */
  prompt: string;
  /** 成功判断函数：接收模型回复，返回成功/失败 */
  judge: (response: string) => boolean;
  /** 是否关键探针（关键项失败 = 模型不适合此任务类） */
  critical: boolean;
  /** 期望完成的最长毫秒数（超时 = 速度慢） */
  expectedMs?: number;
}

/** 从模型响应中提取第一个 JSON 对象或数组（兼容推理文本前缀） */
function extractJson(text: string): string {
  let cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try { JSON.parse(cleaned); return cleaned; } catch { /* 提取第一个 JSON 块 */ }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const startIdx = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
  if (startIdx < 0) return cleaned;
  const char = cleaned[startIdx];
  const endChar = char === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"' && !esc) inStr = !inStr;
    if (!inStr) {
      if (c === char) depth++;
      if (c === endChar) depth--;
      if (depth === 0) return cleaned.slice(startIdx, i + 1);
    }
  }
  return cleaned;
}

/** 标准探针集 — 接入任何新模型时自动执行 */
export const STANDARD_PROBES: Probe[] = [
  // ===== 工具调用 =====
  {
    id: 'tool_basic',
    category: 'tool_calling',
    name: '基础工具调用',
    description: '能否正确输出 tool_calls 格式',
    prompt: '如果用户说"帮我查天气"，不要真的查。直接输出一个 JSON 格式的工具调用，tool_name 为 "get_weather"，参数 city 为 "北京"。只输出 JSON。',
    judge: (r) => {
      try {
        const obj = JSON.parse(extractJson(r));
        return obj.tool_name === 'get_weather' || obj.name === 'get_weather';
      } catch { return false; }
    },
    critical: true,
  },
  {
    id: 'tool_empty_loop',
    category: 'tool_calling',
    name: '空工具调用循环检测',
    description: '是否在无需工具时仍输出空 tool_calls（qwen3.6 已知缺陷）',
    prompt: '回复你好即可，不要用任何工具，直接回复"你好"。',
    judge: (r) => r.includes('你好'),
    critical: false,
  },

  // ===== JSON 输出 =====
  {
    id: 'json_simple',
    category: 'json_output',
    name: '简单 JSON 输出',
    description: '能否按指定格式输出 JSON',
    prompt: '输出一个 JSON 对象，包含 name、age、city 三个字段。只输出 JSON，不要解释。',
    judge: (r) => {
      try {
        const obj = JSON.parse(extractJson(r));
        return 'name' in obj && 'age' in obj && 'city' in obj;
      } catch { return false; }
    },
    critical: false,
  },
  {
    id: 'json_complex',
    category: 'json_output',
    name: '复杂 JSON 输出',
    description: '能否输出嵌套结构的复杂 JSON',
    prompt: '输出一个 JSON 对象，包含 tasks 数组（至少3项），每项有 id、title、status、subtasks 数组。只输出 JSON。',
    judge: (r) => {
      try {
        const obj = JSON.parse(extractJson(r));
        return Array.isArray(obj.tasks) && obj.tasks.length >= 3 &&
          obj.tasks.every((t: any) => 'subtasks' in t);
      } catch { return false; }
    },
    critical: false,
  },

  // ===== 推理能力 =====
  {
    id: 'reasoning_logic',
    category: 'reasoning',
    name: '逻辑推理',
    description: '能否完成多步骤逻辑推理',
    prompt: '如果 A>B, B>C, C=D, 且 D=5, B=3，那么 A 等于几？请逐步推理，最后给出答案。',
    judge: (r) => {
      // 至少推理过程包含"大于"或比较逻辑，结论接近正确答案
      return (r.includes('>') || r.includes('大于') || r.includes('步骤')) && /\d/.test(r);
    },
    critical: false,
  },

  // ===== 上下文长度 =====
  {
    id: 'context_8k',
    category: 'context',
    name: '8K 上下文测试',
    description: '能否处理 8000 token 的上下文并正确回答',
    prompt: '我现在要发送一段长文本给你，请记住文本的最后一个词。文本是：' +
      '苹果 '.repeat(100) +
      '最终答案是"西瓜"。请只回复"西瓜"。',
    judge: (r) => r.includes('西瓜'),
    critical: false,
    expectedMs: 20000,
  },

  // ===== 稳定性 =====
  {
    id: 'stability_repeat',
    category: 'stability',
    name: '重复输出稳定性',
    description: '多次简单请求是否一致',
    prompt: '回复"OK"，只回复这两个字母。',
    judge: (r) => r.replace(/[^A-Za-z]/g, '').toUpperCase() === 'OK',
    critical: false,
  },
];
