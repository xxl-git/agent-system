// 技能缺口感知器 (Phase 3)
// 执行失败/缺能力 → 自动标记缺口
import type { SkillApply } from './types';
import { getRegistry } from './registry';
import logger from '../logger';

export interface GapContext {
  /** 什么操作触发了缺口 */
  action: string;
  /** 需要的功能 */
  needed: string;
  /** 错误信息（如果有） */
  error?: string;
  /** 已有技能列表 */
  availableSkills: string[];
  /** 时间戳 */
  timestamp: string;
}

interface GapEntry {
  ctx: GapContext;
  count: number;
}

export class GapDetector {
  private gaps: Map<string, GapEntry> = new Map();
  /** 同类型缺口出现多少次才自动申请 */
  private threshold = 2;

  /** 检测是否存在能力缺口 */
  detect(context: Omit<GapContext, 'availableSkills' | 'timestamp'>): boolean {
    const registry = getRegistry();

    // 1. 检查是否已有技能覆盖
    const existing = registry.findByCapability(context.needed);
    if (existing.length > 0) {
      logger.debug('[Gap] 已有技能覆盖: ' + existing.map(s => s.name).join(', '));
      return false;
    }

    // 2. 记录缺口
    const key = this.gapKey(context.needed);
    if (this.gaps.has(key)) {
      const entry = this.gaps.get(key)!;
      entry.count++;
      entry.ctx.action = context.action;
    } else {
      this.gaps.set(key, {
        ctx: {
          action: context.action,
          needed: context.needed,
          error: context.error,
          availableSkills: registry.list(),
          timestamp: new Date().toISOString(),
        },
        count: 1,
      });
    }

    logger.info('[Gap] 🔔 能力缺口: ' + context.needed + ' (' + context.action + ')');
    return true;
  }

  /** 生成技能申请（缺口达到阈值） */
  generateApplication(needed: string): SkillApply | null {
    const key = this.gapKey(needed);
    const entry = this.gaps.get(key);
    if (!entry) return null;

    if (entry.count < this.threshold) {
      logger.debug('[Gap] ' + needed + ': ' + entry.count + '/' + this.threshold + '，未达阈值');
      return null;
    }

    return {
      id: 'apply-' + Date.now(),
      name: 'skill-' + needed.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      reason: '执行 "' + entry.ctx.action + '" 时缺少 "' + entry.ctx.needed + '" 能力，已出现 ' + entry.count + ' 次',
      expectedFunction: '提供 ' + needed + ' 功能：' + entry.ctx.action,
      gapContext: entry.ctx.action,
      priority: entry.count >= 3 ? 'P0' : 'P1',
      dangerLevel: this.assessDanger(needed),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  /** 列出当前所有缺口 */
  listGaps(): GapEntry[] {
    return Array.from(this.gaps.values());
  }

  /** 清除已处理的缺口 */
  clear(needed: string): void {
    this.gaps.delete(this.gapKey(needed));
  }

  private gapKey(needed: string): string {
    return needed.toLowerCase().trim();
  }

  private assessDanger(needed: string): 'safe' | 'caution' | 'dangerous' {
    const dangerWords = ['delete', '删除', 'format', '格式化', 'rm', 'uninstall'];
    const cautionWords = ['network', '网络', 'api', 'download', 'install', '安装'];
    const lower = needed.toLowerCase();

    if (dangerWords.some(w => lower.includes(w))) return 'dangerous';
    if (cautionWords.some(w => lower.includes(w))) return 'caution';
    return 'safe';
  }
}

// 单例
let _instance: GapDetector | null = null;
export function getGapDetector(): GapDetector {
  if (!_instance) _instance = new GapDetector();
  return _instance;
}
