// proactive-tasks.ts
// 从 agent-core.ts 提取的 A 型主动性空闲任务注册

import * as fs from 'fs';
import * as path from 'path';
import { agentEventBus } from '@agent-system/events';
import { getConfigSection } from '../../config/agent-system-config';
import logger from '../../logger';

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** AgentCore 的最小接口（避免循环依赖） */
interface ProactiveTasksAgent {
  idleTaskMgr: {
    register(task: any): void;
  };
  summarizer?: {
    gc?: () => Promise<void>;
  };
}

/**
 * 注册 A 型主动性空闲任务
 * @param agent AgentCore 实例
 */
export function registerProactiveTasks(agent: ProactiveTasksAgent): void {
    const idleCfg = getConfigSection('idleTasks');

    // ── 任务 1：记忆整理 (P2, 每周执行一次) ──────────────────
    agent.idleTaskMgr.register({
        id: 'memory-organization',
        name: '记忆整理',
        description: '归档超过 30 天的旧记忆文件，合并为月度摘要',
        priority: 'P2',
        cooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 天
        lastRun: 0,
        running: false,
        createdAt: Date.now(),
        failCount: 0,
        maxFails: idleCfg?.defaultMaxFails ?? 3,
        execute: async () => {
            // 使用配置路径而非硬编码绝对路径，保证可移植性
            const memCfg = getConfigSection('memory');
            const MEMORY_DIR = memCfg?.filePath
                ? (path.isAbsolute(memCfg.filePath) ? memCfg.filePath : path.join(process.cwd(), memCfg.filePath))
                : path.join(process.cwd(), 'memory');
            const ARCHIVE_DIR = path.join(path.dirname(MEMORY_DIR), 'memory-archive');
            const ARCHIVE_THRESHOLD_DAYS = 30;

            try {
                if (!fs.existsSync(MEMORY_DIR)) {
                    logger.debug('[MemoryOrg] 记忆目录不存在，跳过');
                    return true; // 永久任务但跳过
                }

                const now = Date.now();
                const thresholdMs = ARCHIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
                const files = fs.readdirSync(MEMORY_DIR)
                    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                    .map(f => {
                        const stat = fs.statSync(path.join(MEMORY_DIR, f));
                        return { name: f, mtime: stat.mtime.getTime(), size: stat.size };
                    })
                    .filter(f => (now - f.mtime) > thresholdMs)
                    .sort((a, b) => a.mtime - b.mtime);

                if (files.length === 0) {
                    logger.debug(`[MemoryOrg] 无超过 ${ARCHIVE_THRESHOLD_DAYS} 天的记忆文件`);
                    return false; // 保留在队列中，下次继续检查
                }

                // 确保归档目录存在
                if (!fs.existsSync(ARCHIVE_DIR)) {
                    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
                }

                let archivedCount = 0;
                let totalSizeArchived = 0;

                for (const file of files) {
                    const src = path.join(MEMORY_DIR, file.name);
                    // 按年月归档: memory-archive/2026/2026-05/
                    const match = file.name.match(/^(\d{4})-(\d{2})-\d{2}\.md$/);
                    if (!match) continue;
                    const [, year, month] = match;
                    const yearDir = path.join(ARCHIVE_DIR, year);
                    if (!fs.existsSync(yearDir)) {
                        fs.mkdirSync(yearDir, { recursive: true });
                    }

                    const dest = path.join(yearDir, file.name);
                    fs.copyFileSync(src, dest);
                    archivedCount++;
                    totalSizeArchived += file.size;
                    logger.debug(`[MemoryOrg] 归档: ${file.name} -> ${yearDir}/`);
                }

                logger.info(`[MemoryOrg] ✅ 归档完成: ${archivedCount} 个文件, ${(totalSizeArchived / 1024).toFixed(1)} KB`);
                return false; // 保留在队列中持续运行
            } catch (err: unknown) {
                logger.warn(`[MemoryOrg] ❌ 归档失败: ${errorMessage(err)}`);
                return false; // 失败不退出队列
            }
        },
    });

    // ── 任务 2：任务监控告警检查 (P1, 每小时执行一次) ──────
    agent.idleTaskMgr.register({
        id: 'task-monitor-alerts',
        name: '任务监控告警',
        description: '检查 Task Monitor 待处理告警，有未读通知时记录日志',
        priority: 'P1',
        cooldownMs: 60 * 60 * 1000, // 1 小时
        lastRun: 0,
        running: false,
        createdAt: Date.now(),
        failCount: 0,
        maxFails: idleCfg?.defaultMaxFails ?? 3,
        execute: async () => {
            try {
                const http = require('http');
                return new Promise((resolve) => {
                    const req = http.get('http://127.0.0.1:11407/api/alerts', { timeout: 5000 }, (res: any) => {
                        let data = '';
                        res.on('data', (chunk: any) => data += chunk);
                        res.on('end', () => {
                            try {
                                const alerts = JSON.parse(data);
                                if (alerts.pending || (alerts.unread_count > 0)) {
                                    logger.info(`[TaskMonitor] ⚠️  待处理告警: unread=${alerts.unread_count ?? 0}`);
                                    // 通过事件总线通知（有未读时）
                                    if (alerts.unread_count > 0) {
                                        agentEventBus.emitStatus('task_alert', {
                                            message: `Task Monitor 有 ${alerts.unread_count} 条未读通知`,
                                            pending: alerts.pending,
                                        });
                                    }
                                } else {
                                    logger.debug('[TaskMonitor] ✅ 无待处理告警');
                                }
                            } catch {
                                logger.debug('[TaskMonitor] 解析响应失败');
                            }
                            resolve(false); // 保留在队列中
                        });
                    });
                    req.on('error', () => {
                        logger.debug('[TaskMonitor] 服务离线，跳过本次检查');
                        resolve(false); // 保留在队列中，下次继续
                    });
                    req.on('timeout', () => {
                        req.destroy();
                        logger.debug('[TaskMonitor] 请求超时，跳过');
                        resolve(false);
                    });
                });
            } catch (err: unknown) {
                logger.debug(`[TaskMonitor] 检查失败: ${errorMessage(err)}`);
                return false;
            }
        },
    });

    // ── 任务 3：会话摘要整理 (P1, 每天执行一次) ───────────
    agent.idleTaskMgr.register({
        id: 'session-summary-gc',
        name: '会话摘要整理',
        description: '定期触发会话摘要 GC，清理过期的会话摘要记录',
        priority: 'P1',
        cooldownMs: 24 * 60 * 60 * 1000, // 1 天
        lastRun: 0,
        running: false,
        createdAt: Date.now(),
        failCount: 0,
        maxFails: idleCfg?.defaultMaxFails ?? 3,
        execute: async () => {
            try {
                // 调用 summarizer 的 GC 方法（如果存在）
                if (agent.summarizer && typeof agent.summarizer.gc === 'function') {
                    await agent.summarizer.gc();
                    logger.debug('[SessionGC] 会话摘要 GC 完成');
                } else {
                    logger.debug('[SessionGC] summarizer.gc 不可用，跳过');
                }
                return false; // 保留在队列中持续运行
            } catch (err: unknown) {
                logger.debug(`[SessionGC] GC 失败: ${errorMessage(err)}`);
                return false;
            }
        },
    });

    logger.info('[Agent] A 型主动性空闲任务已注册: memory-organization, task-monitor-alerts, session-summary-gc');
}
