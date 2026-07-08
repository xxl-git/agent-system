// Agent 命令处理器 V2 — 最小化可行版本
// 只处理 3 个最简单命令：/help, /history, /status
// @ts-nocheck

export class AgentCommandHandlerV2 {
  private messages: any[];
  private adapter: any;
  private registry: any;
  private gapDetector: any;
  private subAgents: Map<string, any>;
  private projectManager: any;
  private recovery: any;
  private auditLog: any;

  constructor(deps: {
    messages: any[];
    adapter: any;
    registry: any;
    gapDetector: any;
    subAgents: Map<string, any>;
    projectManager: any;
    recovery: any;
    auditLog: any;
  }) {
    this.messages = deps.messages;
    this.adapter = deps.adapter;
    this.registry = deps.registry;
    this.gapDetector = deps.gapDetector;
    this.subAgents = deps.subAgents;
    this.projectManager = deps.projectManager;
    this.recovery = deps.recovery;
    this.auditLog = deps.auditLog;
  }

  /**
   * 尝试处理命令
   * @returns 如果命令被处理，返回回复字符串；否则返回 null（交给 agent-core.ts 处理）
   */
  tryHandle(input: string): string | null {
    const cmd = input.slice(1).toLowerCase().trim();
    const args = cmd.split(/\s+/);
    const action = args[0];

    switch (action) {
      case 'help':
        return this.handleHelp();
      case 'history':
        return this.handleHistory();
      case 'status':
        return this.handleStatus();
      default:
        // 其他命令暂不处理，返回 null 让 agent-core.ts 处理
        return null;
    }
  }

  private handleHelp(): string {
    return `Commands:
  /exit /history /status /project
  /models /router /skills /agents
  /resilience /audit /summarize
  /memory /context /idle /diag /nonsense /config
  /exp [add|list|view|search|edit|delete|stats|help]
  /help`;
  }

  private handleHistory(): string {
    if (this.messages.length <= 1) return 'No history';
    return 'History:\n' + this.messages
      .filter(m => m.role !== 'system')
      .map(m => '[' + m.role + '] ' + m.content.slice(0, 100))
      .join('\n');
  }

  private handleStatus(): string {
    const proj = this.projectManager.getActiveProject();
    const model = this.adapter.model;
    const lines = [
      `Model: ${model}`,
      `Project: ${proj ? proj.project : '(none)'}`,
      `Context: ${this.adapter.contextLength || '?'} tokens`,
      `Messages: ${this.messages.length}`,
      `Skills: ${this.registry.size}`,
      `Gaps: ${this.gapDetector.size}`,
      `SubAgents: ${this.subAgents.size}`,
    ];
    return lines.join('\n');
  }
}
