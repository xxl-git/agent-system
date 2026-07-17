// summarize-command.ts
// 从 agent-core.ts 提取的摘要命令

/** AgentCore 的最小接口（避免循环依赖） */
interface SummarizeCommandAgent {
  messages: Array<{ role: string; content: string }>;
  sessionId: string;
  summarizer: {
    summarizeSession(sessionId: string, messages: any[], _: any[]): Promise<any>;
    getSummaries(sessionId: string): Array<{ timestamp: string; content: string }>;
    getRecentSummaries(n: number): Array<{ timestamp: string; content: string }>;
    patrolSummary(sessionId: string, messages: any[]): Promise<string | null>;
  };
}

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * /summarize — 会话摘要命令
 * @param agent AgentCore 实例
 * @param args 命令参数
 * @returns 用户可见的结果字符串
 */
export async function handleSummarizeCommand(agent: SummarizeCommandAgent, args: string[]): Promise<string> {
    const sub = args[0] || 'now';
    switch (sub) {
        case 'now': {
            const userMsgs = agent.messages.filter(m => m.role === 'user');
            if (userMsgs.length < 3)
                return 'Not enough messages to summarize (need >= 3)';
            try {
                const output = await agent.summarizer.summarizeSession(
                    agent.sessionId,
                    agent.messages.filter(m => m.role !== 'system'),
                    []
                );
                let report = '📋 Summary for ' + agent.sessionId.slice(0, 12) + ':\n';
                report += '  ' + output.sessionSummary + '\n';
                if (output.keyDecisions.length > 0) {
                    report += 'Key decisions (' + output.keyDecisions.length + '):\n';
                    output.keyDecisions.forEach((d: any) => report += '  [' + d.category + '] ' + d.summary + '\n');
                }
                if (output.learnedFacts.length > 0) {
                    report += 'Facts learned (' + output.learnedFacts.length + '):\n';
                    output.learnedFacts.forEach((f: string) => report += '  ✅ ' + f + '\n');
                }
                if (output.tags.length > 0)
                    report += 'Tags: ' + output.tags.join(', ') + '\n';
                if (output.nextSteps.length > 0)
                    report += 'Next: ' + output.nextSteps.join('; ');
                return report;
            }
            catch (err) {
                return 'Summarization failed: ' + errorMessage(err);
            }
        }
        case 'list': {
            const summaries = agent.summarizer.getSummaries(agent.sessionId);
            if (summaries.length === 0)
                return 'No summaries yet';
            return 'Summaries (' + summaries.length + '):\n' + summaries.map(s => '  [' + s.timestamp.slice(0, 16) + '] ' + s.content.slice(0, 100)).join('\n');
        }
        case 'recent': {
            const recent = agent.summarizer.getRecentSummaries(5);
            if (recent.length === 0)
                return 'No recent summaries';
            return 'Recent (' + recent.length + '):\n' + recent.map(r => '  [' + r.timestamp.slice(0, 16) + '] ' + r.content.slice(0, 100)).join('\n');
        }
        case 'patrol': {
            const patrol = await agent.summarizer.patrolSummary(agent.sessionId, agent.messages);
            return patrol || 'Below patrol threshold (' + agent.messages.length + ' msgs)';
        }
        default: return 'Summarize: /summarize now|list|recent|patrol';
    }
}
