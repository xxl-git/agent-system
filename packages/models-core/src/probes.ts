// 能力探测 — 探针定义
export type ProbeCategory = 'tool_calling' | 'json_output' | 'reasoning' | 'speed' | 'context' | 'stability';

export interface Probe {
  id: string;
  category: ProbeCategory;
  name: string;
  description: string;
  prompt: string;
  judge: (response: string) => boolean;
  critical: boolean;
  expectedMs?: number;
}

export function extractJson(text: string): string {
  let cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try { JSON.parse(cleaned); return cleaned; } catch {}
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

export const STANDARD_PROBES: Probe[] = [
  { id: 'tool_basic', category: 'tool_calling', name: '基础工具调用', description: '能否正确输出 tool_calls 格式', prompt: '如果用户说"帮我查天气"，不要真的查。直接输出一个 JSON 格式的工具调用，tool_name 为 "get_weather"，参数 city 为 "北京"。只输出 JSON。', judge: (r) => { try { const obj = JSON.parse(extractJson(r)); return obj.tool_name === 'get_weather' || obj.name === 'get_weather'; } catch { return false; } }, critical: true },
  { id: 'tool_empty_loop', category: 'tool_calling', name: '空工具调用循环检测', description: '是否在无需工具时仍输出空 tool_calls', prompt: '回复你好即可，不要用任何工具，直接回复"你好"。', judge: (r) => r.includes('你好'), critical: false },
  { id: 'json_simple', category: 'json_output', name: '简单 JSON 输出', description: '能否按指定格式输出 JSON', prompt: '输出一个 JSON 对象，包含 name、age、city 三个字段。只输出 JSON，不要解释。', judge: (r) => { try { const obj = JSON.parse(extractJson(r)); return 'name' in obj && 'age' in obj && 'city' in obj; } catch { return false; } }, critical: false },
  { id: 'json_complex', category: 'json_output', name: '复杂 JSON 输出', description: '能否输出嵌套结构的复杂 JSON', prompt: '输出一个 JSON 对象，包含 tasks 数组（至少3项），每项有 id、title、status、subtasks 数组。只输出 JSON。', judge: (r) => { try { const obj = JSON.parse(extractJson(r)); return Array.isArray(obj.tasks) && obj.tasks.length >= 3 && obj.tasks.every((t: any) => 'subtasks' in t); } catch { return false; } }, critical: false },
  { id: 'reasoning_logic', category: 'reasoning', name: '逻辑推理', description: '能否完成多步骤逻辑推理', prompt: '如果 A>B, B>C, C=D, 且 D=5, B=3，那么 A 等于几？请逐步推理，最后给出答案。', judge: (r) => (r.includes('>') || r.includes('大于') || r.includes('步骤')) && /\d/.test(r), critical: false },
  { id: 'context_8k', category: 'context', name: '8K 上下文测试', description: '能否处理 8000 token 的上下文', prompt: '文本是：' + '苹果 '.repeat(100) + '最终答案是"西瓜"。请只回复"西瓜"。', judge: (r) => r.includes('西瓜'), critical: false, expectedMs: 20000 },
  { id: 'stability_repeat', category: 'stability', name: '重复输出稳定性', description: '多次简单请求是否一致', prompt: '回复"OK"，只回复这两个字母。', judge: (r) => r.replace(/[^A-Za-z]/g, '').toUpperCase() === 'OK', critical: false },
];
