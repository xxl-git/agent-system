// ═══════════════════════════════════════════════════════════════
// Message Assembly Inspector — 消息装配流水线追踪
// 记录用户输入经过每一道加工环节后的消息形态变化
// ═══════════════════════════════════════════════════════════════

export interface AssemblyStage {
  name: string;
  label: string;
  description: string;
  messages: Array<{ role: string; content: string }>;
  stats: Record<string, number | string>;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface AssemblyReport {
  sessionId: string;
  userInput: string;
  stages: AssemblyStage[];
  totalDurationMs: number;
  startedAt: number;
}

let _assemblyHistory = new Map<string, AssemblyReport>();

/**
 * 创建装配报告
 */
export function createAssemblyReport(sessionId: string, userInput: string): AssemblyReport {
  const report: AssemblyReport = {
    sessionId,
    userInput,
    stages: [],
    totalDurationMs: 0,
    startedAt: Date.now(),
  };
  _assemblyHistory.set(sessionId, report);
  // 限制历史数量
  if (_assemblyHistory.size > 50) {
    const firstKey = _assemblyHistory.keys().next().value;
    if (firstKey !== undefined) _assemblyHistory.delete(firstKey);
  }
  return report;
}

/**
 * 添加装配阶段记录
 */
export function addAssemblyStage(
  report: AssemblyReport,
  name: string,
  label: string,
  description: string,
  messages: Array<{ role: string; content: string }>,
): void {
  const now = Date.now();
  const prev = report.stages.length > 0 ? report.stages[report.stages.length - 1] : null;

  const stats: Record<string, number | string> = {
    msgCount: messages.length,
    totalChars: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
    sysChars: messages.filter(m => m.role === 'system').reduce((s, m) => s + (m.content?.length || 0), 0),
    userChars: messages.filter(m => m.role === 'user').reduce((s, m) => s + (m.content?.length || 0), 0),
    assistantChars: messages.filter(m => m.role === 'assistant').reduce((s, m) => s + (m.content?.length || 0), 0),
  };

  // 对比上一阶段的变化
  if (prev) {
    const prevTotal = prev.stats.totalChars;
    const diff = Number(prevTotal) > 0 ? Number(stats.totalChars) - Number(prevTotal) : 0;
    stats.diffChars = String(diff > 0 ? `+${diff}` : `${diff}`);
    stats.diffMsgs = Number(stats.msgCount) - Number(prev.stats.msgCount);
    // 标记是否有摘要注入
    if (name === 'context_compressed') {
      stats.hasSummary = messages.some(m =>
        m.content?.includes('此前对话摘要') || m.content?.includes('[摘要结束]')
      ) ? '✅' : '❌';
    }
    if (name === 'memory_injected') {
      stats.hasMemory = messages.some(m => m.content?.includes('[历史背景]')) ? '✅' : '❌';
    }
    if (name === 'experience_injected') {
      stats.hasExperience = messages.some(m => m.content?.includes('[经验参考]')) ? '✅' : '❌';
    }
  }

  const stage: AssemblyStage = {
    name,
    label,
    description,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content || '',
    })),
    stats,
    startedAt: prev?.endedAt || report.startedAt,
    endedAt: now,
    durationMs: now - (prev?.endedAt || report.startedAt),
  };

  report.stages.push(stage);
  report.totalDurationMs = now - report.startedAt;
}

/**
 * 获取装配报告
 */
export function getAssemblyReport(sessionId?: string): AssemblyReport | null {
  if (sessionId) {
    return _assemblyHistory.get(sessionId) ?? null;
  }
  // 返回最新
  const entries = [..._assemblyHistory.entries()];
  if (entries.length === 0) return null;
  return entries[entries.length - 1][1];
}

/**
 * 将装配报告格式化为文本（供日志使用）
 */
export function formatAssemblyReport(report: AssemblyReport): string {
  const lines: string[] = [];
  lines.push(`══════ 消息装配流水线 ══════`);
  lines.push(`session: ${report.sessionId}`);
  lines.push(`input: ${report.userInput.slice(0, 80)}`);
  lines.push('');

  let stageNum = 0;
  for (const stage of report.stages) {
    stageNum++;
    lines.push(`── Stage ${stageNum}: ${stage.label} ── (${stage.durationMs}ms)`);
    lines.push(`   消息: ${stage.stats.msgCount}条 | 总字数: ${stage.stats.totalChars}字`);

    // 显示变化
    if (stage.stats.diffChars !== undefined) {
      lines.push(`   变化: 消息${Number(stage.stats.diffMsgs) > 0 ? `+${stage.stats.diffMsgs}` : stage.stats.diffMsgs}条, 字数${stage.stats.diffChars}`);
    }
    if (String(stage.stats.hasSummary) === '✅') lines.push(`   摘要注入: ✅ 已注入压缩摘要`);
    if (String(stage.stats.hasMemory) === '✅') lines.push(`   记忆注入: ✅ 已注入历史记忆`);
    if (String(stage.stats.hasExperience) === '✅') lines.push(`   经验注入: ✅ 已注入相关经验`);

    // 每条消息摘要
    for (const msg of stage.messages) {
      const roleLabel = msg.role === 'system' ? '系统' : msg.role === 'user' ? '用户' : '助手';
      const brief = msg.content.slice(0, 60).replace(/\n/g, '\\n');
      lines.push(`   [${roleLabel}] ${brief}${msg.content.length > 60 ? '…' : ''}`);
    }
    lines.push('');
  }

  lines.push(`══════ 总耗时: ${report.totalDurationMs}ms ══════`);
  return lines.join('\n');
}
