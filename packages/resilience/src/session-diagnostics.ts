// 会话诊断 — 模型异常停止时自动记录和排查
// 职责：记录待诊断快照 · 自动生成 P0 诊断任务 · 诊断分析引擎
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { getIdleTaskManager, IdleTaskManager } from './idle-task-manager';
import { getConfigSection } from './config';

export interface DiagnosticSnapshot {
  /** 快照唯一 ID */
  id: string;
  /** 发生时间 */
  timestamp: string;
  /** 当前加载的模型名 */
  model: string;
  /** 触发原因 */
  trigger: 'ping_failure' | 'timeout' | 'empty_response' | 'circuit_breaker' | 'manual';
  /** 会话 ID */
  sessionId: string;
  /** 错误消息 */
  error: string;
  /** 最近的对话历史（前 5 条） */
  recentMessages: { role: string; content: string; length: number }[];
  /** 可用探针结果（如果有） */
  probeSummary: string;
  /** 是否已诊断 */
  diagnosed: boolean;
  /** 诊断结论 */
  diagnosis?: string;
  /** 诊断时间 */
  diagnosedAt?: string;
}

export class SessionDiagnostics {
  private snapshotsDir: string;
  private taskManager: IdleTaskManager;
  private lastPingSuccess = true;
  private consecutivePingFailures = 0;
  private modelName = 'unknown';

  constructor(taskManager?: IdleTaskManager) {
    this.snapshotsDir = path.join(process.cwd(), 'data', 'pending-diagnostics');
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
    this.taskManager = taskManager || getIdleTaskManager();
  }

  /** 注入当前模型名（由 AgentCore 在初始化或探测时调用） */
  setModelName(name: string): void {
    this.modelName = name;
  }

  /** Ping 结束后调用：记录结果，检测连续失败 */
  recordPing(success: boolean): void {
    if (success) {
      this.lastPingSuccess = true;
      this.consecutivePingFailures = 0;
    } else {
      this.lastPingSuccess = false;
      this.consecutivePingFailures++;
    }

    // 从配置读取最大 Ping 失败次数阈值
    const diagCfg = (() => { try { return getConfigSection('diagnostics'); } catch { return null; } })();
    const maxFails = diagCfg?.maxPingFailures ?? 3;
    if (this.consecutivePingFailures >= maxFails) {
      this.triggerDiagnostic({
        trigger: 'ping_failure',
        error: `连续 ${this.consecutivePingFailures} 次 Ping 失败`,
        recentMessages: [],
      });
      this.consecutivePingFailures = 0; // 已触发，重置计数
    }
  }

  /** 超时或空响应时触发诊断 */
  recordFailure(trigger: 'timeout' | 'empty_response', error: string, recentMessages: { role: string; content: string; length: number }[]): void {
    this.triggerDiagnostic({ trigger, error, recentMessages });
  }

  /** 熔断器打开时触发诊断 */
  recordCircuitBreaker(model: string, reason: string): void {
    this.triggerDiagnostic({
      trigger: 'circuit_breaker',
      error: `熔断器打开: ${reason} (模型: ${model})`,
      recentMessages: [],
    });
  }

  /** 手动触发诊断 */
  recordManual(reason: string, recentMessages: { role: string; content: string; length: number }[]): void {
    this.triggerDiagnostic({ trigger: 'manual', error: reason, recentMessages });
  }

  /** 内部：创建诊断快照并注册 P0 空闲任务 */
  private triggerDiagnostic(params: {
    trigger: DiagnosticSnapshot['trigger'];
    error: string;
    recentMessages: { role: string; content: string; length: number }[];
  }): void {
    const id = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const snapshot: DiagnosticSnapshot = {
      id,
      timestamp: new Date().toISOString(),
      model: this.modelName,
      trigger: params.trigger,
      sessionId: `session-diagnostics-${Date.now()}`,
      error: params.error,
      recentMessages: params.recentMessages.slice(-5),
      probeSummary: '',
      diagnosed: false,
    };

    // 持久化快照
    this.saveSnapshot(snapshot);

    // 注册 P0 空闲诊断任务（使用全局 idleTasks 配置）
    const idleCfg = (() => { try { return getConfigSection('idleTasks'); } catch { return { defaultCooldownMs: 60000, defaultMaxFails: 3 }; } })();
    this.taskManager.register({
      id: `diagnose-${id}`,
      name: `诊断: ${params.trigger}`,
      description: `排查模型异常: ${params.error}`,
      priority: 'P0',
      cooldownMs: idleCfg.defaultCooldownMs,
      lastRun: 0,
      running: false,
      createdAt: Date.now(),
      failCount: 0,
      maxFails: idleCfg.defaultMaxFails,
      execute: async () => {
        return await this.runDiagnosis(id);
      },
    });

    logger.warn(`[Diag] 已记录待诊断快照 ${id}: ${params.trigger} — ${params.error}`);
  }

  /** 执行诊断 */
  private async runDiagnosis(id: string): Promise<boolean> {
    const snapshot = this.loadSnapshot(id);
    if (!snapshot) {
      logger.warn(`[Diag] 快照 ${id} 不存在`);
      return true; // 移除该任务
    }

    logger.info(`[Diag] 🔍 正在诊断 #${id} (${snapshot.trigger})`);

    // 诊断逻辑
    const findings: string[] = [];
    const suggestions: string[] = [];

    switch (snapshot.trigger) {
      case 'ping_failure': {
        findings.push('LM Studio API 连续无响应');
        suggestions.push('检查 LM Studio 进程是否运行');
        suggestions.push('检查端口 1234 是否被占用');
        suggestions.push('尝试重启 LM Studio');
        break;
      }
      case 'timeout': {
        findings.push('模型响应超时 — 可能原因: 显卡负载高、模型太大、参数配置过高');
        suggestions.push('检查 GPU 利用率');
        suggestions.push('降低 max_tokens 或 temperature');
        suggestions.push('更换为更小的模型');
        break;
      }
      case 'empty_response': {
        findings.push('模型返回空响应 — 可能原因: 上下文超长、模型崩溃、context_length 不足');
        suggestions.push('检查上下文窗口使用率');
        suggestions.push('重启 LM Studio');
        suggestions.push('检查模型输出格式');
        break;
      }
      case 'circuit_breaker': {
        findings.push(`熔断器触发: ${snapshot.error}`);
        const recentMsgs = snapshot.recentMessages;
        if (recentMsgs.length > 0) {
          findings.push(`最近请求: ${recentMsgs.map(m => `${m.role}(${m.length}字)`).join(' → ')}`);
        }
        suggestions.push('等待熔断器自动恢复');
        suggestions.push('检查是否连续空响应或重复回复');
        suggestions.push('检查模型是否正常加载');
        break;
      }
      case 'manual': {
        findings.push('手动触发的诊断');
        suggestions.push('检查相关配置');
        break;
      }
    }

    // 结合探针数据
    const probeDir = path.join(process.cwd(), 'data', 'profiles');
    if (fs.existsSync(probeDir)) {
      try {
        const files = fs.readdirSync(probeDir).filter(f => f.endsWith('.json'));
        const probeInfo = files.map(f => {
          try {
            const p = JSON.parse(fs.readFileSync(path.join(probeDir, f), 'utf-8'));
            const score = p.capability?.overallScore;
            const stage = p.stage || 'unknown';
            return `${f.replace('.json', '')}: stage=${stage}, score=${score ? (score * 100).toFixed(0) + '%' : 'N/A'}`;
          } catch { return f; }
        }).join('; ');
        if (probeInfo) snapshot.probeSummary = probeInfo;
      } catch { /* ignore */ }
    }

    // 补全诊断结果
    snapshot.diagnosed = true;
    snapshot.diagnosis = [
      `🩺 诊断结论 (#${id}): ${snapshot.trigger}`,
      `模型: ${snapshot.model}`,
      `时间: ${snapshot.timestamp}`,
      '',
      '发现:',
      ...findings.map(f => `  • ${f}`),
      '',
      '建议:',
      ...suggestions.map(s => `  • ${s}`),
      snapshot.probeSummary ? `\n探针状态: ${snapshot.probeSummary}` : '',
    ].join('\n');
    snapshot.diagnosedAt = new Date().toISOString();

    // 更新快照文件
    this.saveSnapshot(snapshot);

    // 写入诊断报告
    const reportPath = path.join(this.snapshotsDir, `${id}_report.md`);
    try {
      fs.writeFileSync(reportPath, snapshot.diagnosis, 'utf-8');
      logger.info(`[Diag] ✅ 诊断报告已生成: ${reportPath}`);
    } catch (err) {
      logger.warn(`[Diag] 诊断报告写入失败: ${err}`);
    }

    logger.info(`[Diag] ✅ 诊断完成 — ${findings[0] || '无异常发现'}`);
    return true; // 任务完成，从队列移除
  }

  private saveSnapshot(snapshot: DiagnosticSnapshot): void {
    const filePath = path.join(this.snapshotsDir, `${snapshot.id}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`[Diag] 快照写入失败: ${err}`);
    }
  }

  private loadSnapshot(id: string): DiagnosticSnapshot | null {
    const filePath = path.join(this.snapshotsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 获取所有未诊断的快照 */
  getUndiagnosedSnapshots(): DiagnosticSnapshot[] {
    try {
      if (!fs.existsSync(this.snapshotsDir)) return [];
      return fs.readdirSync(this.snapshotsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.snapshotsDir, f), 'utf-8'));
          } catch { return null; }
        })
        .filter((s): s is DiagnosticSnapshot => s !== null && !s.diagnosed);
    } catch {
      return [];
    }
  }

  /** 获取所有诊断报告路径 */
  getReportPaths(): string[] {
    try {
      if (!fs.existsSync(this.snapshotsDir)) return [];
      return fs.readdirSync(this.snapshotsDir)
        .filter(f => f.endsWith('_report.md'))
        .map(f => path.join(this.snapshotsDir, f));
    } catch {
      return [];
    }
  }

  /** 获取统计 */
  getStats(): { totalSnapshots: number; undiagnosed: number; diagnosed: number; reports: number } {
    const files = (fs.existsSync(this.snapshotsDir) ? fs.readdirSync(this.snapshotsDir) : []);
    return {
      totalSnapshots: files.filter(f => f.endsWith('.json')).length,
      undiagnosed: this.getUndiagnosedSnapshots().length,
      diagnosed: files.filter(f => f.endsWith('.json') && f.includes('_report')).length,
      reports: files.filter(f => f.endsWith('.md')).length,
    };
  }
}

// 单例
let instance: SessionDiagnostics | null = null;

export function getSessionDiagnostics(taskManager?: IdleTaskManager): SessionDiagnostics {
  if (!instance) instance = new SessionDiagnostics(taskManager);
  return instance;
}
