export interface DifficultyReport {
  score: number; level: 'trivial' | 'simple' | 'moderate' | 'complex' | 'hard';
  factors: string[]; estimatedToolCalls: number; requiresExternalAPI: boolean;
  contextComplexity: number; isArchitectureTask: boolean; suggestion: string;
}

const HARD_SIGNALS = ['架构', '设计', '重构', '系统', '框架', 'architecture', 'design', 'refactor', 'system', 'framework'];
const COMPLEX_SIGNALS = ['多线程', '并发', '数据库', '优化', '安全', 'multithread', 'concurrent', 'database', 'optimize', 'security'];
const SIMPLE_SIGNALS = ['你好', '天气', '时间', '日期', '怎么', 'hello', 'hi', 'weather', 'time', 'date'];
const TOOL_SIGNALS = ['创建', '写', '删除', '读取', '搜索', '下载', 'create', 'write', 'delete', 'read', 'search', 'download'];

export function assessDifficulty(userInput: string, toolCount = 0): DifficultyReport {
  const input = userInput.toLowerCase();
  const factors: string[] = [];
  let score = 20;
  if (userInput.length > 200) { score += 15; factors.push('长文本 (>200字)'); }
  else if (userInput.length > 100) { score += 8; factors.push('中等长度'); }
  const hardMatches = HARD_SIGNALS.filter(s => input.includes(s)).length;
  if (hardMatches >= 2) { score += 30; factors.push('架构级任务'); }
  else if (hardMatches >= 1) { score += 15; factors.push('复杂设计任务'); }
  if (COMPLEX_SIGNALS.some(s => input.includes(s))) { score += 10; factors.push('涉及复杂主题'); }
  if (SIMPLE_SIGNALS.some(s => input.includes(s))) { score = Math.max(5, score - 15); factors.push('日常问答'); }
  const toolSignals = TOOL_SIGNALS.filter(s => input.includes(s)).length;
  const estimatedTools = Math.max(toolCount, toolSignals) || 1;
  if (estimatedTools >= 4) { score += 20; factors.push('多工具调用'); }
  else if (estimatedTools >= 2) { score += 10; factors.push('需要工具'); }
  const needsExternal = /http|api|联网|上网|在线|web/.test(input);
  if (needsExternal) { score += 10; factors.push('依赖外部API'); }
  const contextComplexity = Math.min(10, Math.ceil(score / 10));
  const isArchitecture = hardMatches >= 2 || /架构|设计模式|最佳实践/.test(input);
  let level: DifficultyReport['level'];
  if (score >= 70) level = 'hard';
  else if (score >= 50) level = 'complex';
  else if (score >= 30) level = 'moderate';
  else if (score >= 15) level = 'simple';
  else level = 'trivial';
  let suggestion: string;
  if (level === 'hard' || level === 'complex') suggestion = '在线模型（高推理能力）';
  else if (level === 'moderate') suggestion = '本地模型（优先）或在线（过阈值）';
  else suggestion = '本地模型（快速低成本）';
  return { score, level, factors, estimatedToolCalls: estimatedTools,
    requiresExternalAPI: needsExternal, contextComplexity, isArchitectureTask: isArchitecture, suggestion };
}
