// 会话完成检测器 — 模型响应异常时自动记录并触发电空闲诊断
// 职责：全程 10s 轮询 · 会话生命周期跟踪 · 异常快照 · P0 空闲任务
// 所有阈值和规则从 config/agent-system.yaml 读取，用户可编辑。
import { logger } from './logger';
import { getIdleTaskManager, IdleTaskManager } from './idle-task-manager';
import { getNonsenseConfig, getConfig, CompiledNonsenseConfig } from './config';
import * as fs from 'fs';
import * as path from 'path';

export interface ConversationRecord {
  input: string;
  output: string;
  timestamp: number;
  endedNormally: boolean;
  reason?: string;
}

export class NonsenseDetector {
  private taskManager: IdleTaskManager;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  /** 🔧 从配置文件读取（热重载生效） */
  private get cfg(): CompiledNonsenseConfig {
    return getNonsenseConfig();
  }

  // 会话状态
  private conversationActive = false;
  private conversationStartTime = 0;
  private pendingInput = '';
  private lastConversation: ConversationRecord | null = null;
  private modelName = 'unknown';

  constructor(taskManager?: IdleTaskManager) {
    this.taskManager = taskManager || getIdleTaskManager();
  }

  setModelName(name: string): void { this.modelName = name; }

  // ====== 会话生命周期 ======

  markConversationStart(userInput?: string): void {
    this.conversationActive = true;
    this.conversationStartTime = Date.now();
    this.pendingInput = userInput || this.pendingInput;
    logger.debug(`[Nonsense] 会话开始`);
  }

  markConversationEnd(normal: boolean, input: string, output: string, reason?: string): void {
    this.conversationActive = false;
    this.conversationStartTime = 0;
    this.pendingInput = '';
    this.lastConversation = {
      input: input.slice(0, 500),
      output: output.slice(0, 500),
      timestamp: Date.now(),
      endedNormally: normal,
      reason: reason || (normal ? undefined : '检测到异常'),
    };
    if (!normal) {
      logger.warn(`[Nonsense] ⚠️ 会话异常结束: ${reason || '检测到异常'}`);
    }
  }

  getLastConversation(): ConversationRecord | null { return this.lastConversation; }
  isConversationActive(): boolean { return this.conversationActive; }

  getConversationElapsedMs(): number {
    if (!this.conversationActive || this.conversationStartTime === 0) return 0;
    return Date.now() - this.conversationStartTime;
  }

  forceCheck(): void { this.tick(); }

  // ====== 监控生命周期 ======

  startMonitor(): void {
    if (this.monitorTimer) return;
    const interval = this.cfg.checkIntervalMs;
    this.monitorTimer = setInterval(() => this.tick(), interval);
    if (this.monitorTimer && typeof this.monitorTimer === 'object' && 'unref' in this.monitorTimer) {
      (this.monitorTimer as NodeJS.Timeout).unref();
    }
    logger.info(`[Nonsense] 📡 监控已启动 (${(interval / 1000).toFixed(0)}s 间隔)`);
  }

  stopMonitor(): void {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    logger.info('[Nonsense] 📡 监控已停止');
  }

  // ====== 重启监控（热重载配置后调用）=====
  restartMonitor(): void {
    this.stopMonitor();
    this.startMonitor();
  }

  // ====== 胡话检测器（静态方法，目前保留为实例方法也会调用） ======

  /** 使用当前配置检测一段文本是否属于胡话 */
  static detectGibberish(text: string): string | null {
    // 读取配置中的阈值和自定义规则
    const cfg = getNonsenseConfig();
    const thr = cfg.thresholds;

    if (!text || text.trim().length === 0) return '空响应';
    const trimmed = text.trim();

    // 1. 过短检测
    if (trimmed.replace(/[\s.,!?;:。，！？；：、…~\-=+*#@%&/\\|<>《》【】""''（）()\[\]{}]/g, '').length < thr.minEffectiveChars) {
      return '响应过短或仅含标点';
    }

    // 2. 高重复率
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === ' ' || ch === '\n') continue;
      let count = 0;
      for (let j = 0; j < trimmed.length; j++) { if (trimmed[j] === ch) count++; }
      if (count / trimmed.length > thr.highRepeatRatio && trimmed.length > thr.highRepeatMinLength) {
        return `字符高重复: '${ch}' 出现 ${count}/${trimmed.length} 次`;
      }
    }

    // 3. 文本循环重复
    if (trimmed.length >= thr.loopDetectMinLength) {
      const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
      if (stripped.length < thr.loopDetectMinStrippedLength) return '响应过短(去标点后)';
      for (let segLen = 2; segLen <= Math.floor(stripped.length / 2); segLen++) {
        const seg = stripped.slice(0, segLen);
        if (stripped.length % segLen !== 0) continue;
        let match = true;
        for (let k = segLen; k < stripped.length; k += segLen) {
          if (stripped.slice(k, k + segLen) !== seg) { match = false; break; }
        }
        if (match && stripped.length / segLen >= 2) {
          return `文本循环重复 ("${seg}" × ${stripped.length / segLen})`;
        }
      }
      const unique = new Set(stripped).size;
      if (unique / stripped.length < thr.lowDiversityRatio && stripped.length > thr.lowDiversityMinLength) {
        return `字符多样性低 (${unique}/${stripped.length})`;
      }
    }

    // 4. 纯符号输出
    const alphaNum = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
    if (alphaNum === 0) return '输出仅为符号/空白';

    // 5. 模型崩溃标记（内置 + 用户自定义）
    const builtinPatterns = [
      /internal server error/i,
      /model .{0,20}(crashed|died|unrecoverable)/i,
      /context length exceeded/i,
      /out of memory/i,
      /OOM/i,
    ];
    const allPatterns = builtinPatterns.concat(cfg.crashPatterns);
    for (const p of allPatterns) {
      if (p.test(trimmed)) return `模型错误: ${trimmed.slice(0, 80)}`;
    }

    // 6. 用户自定义规则
    for (const rule of cfg.customRules) {
      if (!rule.active) continue;
      if (rule.regex && rule.regex.test(trimmed)) {
        return `自定义规则 "${rule.name}": ${trimmed.slice(0, 80)}`;
      }
    }

    return null; // 正常
  }

  // ====== 内部实现 ======

  private tick(): void {
    // — 场景 A: 会话挂起 —
    if (this.conversationActive) {
      const maxDuration = this.cfg.maxConversationDurationMs;
      if (maxDuration <= 0) return;
      const elapsed = Date.now() - this.conversationStartTime;
      if (elapsed < maxDuration) return;
      this.conversationActive = false;
      this.conversationStartTime = 0;
      const input = this.pendingInput || '(未知输入)';
      const reason = `会话挂起(>${(maxDuration / 1000).toFixed(0)}s 未完成)`;
      logger.error(`[Nonsense] 🚨 ${reason} — input: ${input.slice(0, 100)}`);
      this.lastConversation = {
        input: input.slice(0, 500),
        output: '(模型未响应 — 会话被强制结束)',
        timestamp: Date.now(),
        endedNormally: false,
        reason,
      };
      this.saveAndAlert(reason, input, '(模型未响应 — 会话被强制结束)');
      this.pendingInput = '';
      return;
    }

    // — 场景 B: 空闲 + 上次异常 —
    const last = this.lastConversation;
    if (!last || last.endedNormally) return;

    const idleMs = Date.now() - last.timestamp;
    logger.warn(`[Nonsense] 🚨 模型空闲 ${(idleMs / 1000).toFixed(0)}s，上次会话异常: ${last.reason || '未知'}`);
    this.saveAndAlert(last.reason || '异常', last.input, last.output);
    this.lastConversation = null;
  }

  /** 保存快照 + 注册P0（避免 tick 内重复代码） */
  private saveAndAlert(reason: string, input: string, output: string): void {
    const id = `nonsense-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.saveDiagnosticSnapshot(id, reason, input, output);
    this.registerP0Task(id, reason);
  }

  private saveDiagnosticSnapshot(id: string, reason: string, input: string, output: string): void {
    const dir = path.join(process.cwd(), 'data', 'pending-diagnostics');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const snapshot = {
      id, timestamp: new Date().toISOString(), model: this.modelName,
      trigger: 'nonsense_detected', source: 'NonsenseDetector (10s monitor)',
      error: reason,
      conversation: {
        input: input.slice(0, 2000), output: output.slice(0, 2000),
        inputLength: input.length, outputLength: output.length,
      },
      diagnosed: false,
    };
    const filePath = path.join(dir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    logger.info(`[Nonsense] 📝 诊断快照已保存: ${filePath}`);
  }

  private registerP0Task(id: string, reason: string): void {
    this.taskManager.register({
      id: `diagnose-${id}`,
      name: `会话异常诊断: ${reason}`,
      description: `模型响应异常诊断: ${reason} (快照: ${id})`,
      priority: 'P0', cooldownMs: 60000, lastRun: 0, running: false,
      createdAt: Date.now(), failCount: 0, maxFails: 3,
      execute: async () => {
        const dir = path.join(process.cwd(), 'data', 'pending-diagnostics');
        const snapshotPath = path.join(dir, `${id}.json`);
        if (!fs.existsSync(snapshotPath)) { logger.warn(`[Nonsense] 诊断快照 ${id} 不存在，跳过`); return true; }
        logger.info(`[Nonsense] 🔍 正在诊断 #${id}: ${reason}`);
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
        const report = [
          `🩺 会话异常诊断报告 (#${id})`,
          `模型: ${snapshot.model || 'unknown'}`,
          `时间: ${snapshot.timestamp}`,
          `触发原因: ${reason}`,
          '',
          '发现:',
          `  • 模型输出异常: ${snapshot.error}`,
          `  • 输入长度: ${snapshot.conversation?.inputLength || 'N/A'} 字`,
          `  • 输出长度: ${snapshot.conversation?.outputLength || 'N/A'} 字`,
          `  • 输入前 200 字: ${(snapshot.conversation?.input || '').slice(0, 200)}`,
          `  • 输出前 200 字: ${(snapshot.conversation?.output || '').slice(0, 200)}`,
          '', '建议:', '  • 检查 LM Studio 是否正常运行',
          '  • 检查模型输出是否合理', '  • 尝试重启 LM Studio',
          '  • 查看完整日志排查根因', '', '---', '由 NonsenseDetector 自动生成',
        ].join('\n');
        const reportPath = path.join(dir, `${id}_report.md`);
        fs.writeFileSync(reportPath, report, 'utf-8');
        logger.info(`[Nonsense] ✅ 诊断报告已生成: ${reportPath}`);
        return true;
      },
    });
    logger.warn(`[Nonsense] 📋 P0 空闲诊断任务已注册: diagnose-${id}`);
  }
}

// 单例
let instance: NonsenseDetector | null = null;
export function getNonsenseDetector(taskManager?: IdleTaskManager): NonsenseDetector {
  if (!instance) instance = new NonsenseDetector(taskManager);
  return instance;
}
