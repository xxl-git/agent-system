import type { SkillApply } from './types';
import { getRegistry } from './registry';
import { logger } from './logger';

export interface GapContext {
  action: string; needed: string; error?: string; availableSkills: string[]; timestamp: string;
}
interface GapEntry { ctx: GapContext; count: number; }

export class GapDetector {
  private gaps: Map<string, GapEntry> = new Map();
  private threshold = 2;
  detect(context: Omit<GapContext, 'availableSkills' | 'timestamp'>): boolean {
    const registry = getRegistry();
    const existing = registry.findByCapability(context.needed);
    if (existing.length > 0) { logger.debug('[Gap] 已有技能覆盖: ' + existing.map(s => s.name).join(', ')); return false; }
    const key = this.gapKey(context.needed);
    if (this.gaps.has(key)) { this.gaps.get(key)!.count++; this.gaps.get(key)!.ctx.action = context.action; }
    else { this.gaps.set(key, { ctx: { action: context.action, needed: context.needed, error: context.error, availableSkills: registry.list(), timestamp: new Date().toISOString() }, count: 1 }); }
    logger.info('[Gap] 🔔 能力缺口: ' + context.needed + ' (' + context.action + ')'); return true;
  }
  generateApplication(needed: string): SkillApply | null {
    const entry = this.gaps.get(this.gapKey(needed));
    if (!entry || entry.count < this.threshold) return null;
    return {
      id: 'apply-' + Date.now(), name: 'skill-' + needed.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      reason: `执行 "${entry.ctx.action}" 时缺少 "${entry.ctx.needed}" 能力，已出现 ${entry.count} 次`,
      expectedFunction: `提供 ${needed} 功能：${entry.ctx.action}`, gapContext: entry.ctx.action,
      priority: entry.count >= 3 ? 'P0' : 'P1', dangerLevel: this.assessDanger(needed),
      status: 'pending', createdAt: new Date().toISOString(),
    };
  }
  listGaps(): GapEntry[] { return Array.from(this.gaps.values()); }
  clear(needed: string): void { this.gaps.delete(this.gapKey(needed)); }
  private gapKey(needed: string): string { return needed.toLowerCase().trim(); }
  private assessDanger(needed: string): 'safe' | 'caution' | 'dangerous' {
    const dangerWords = ['delete', '删除', 'format', '格式化', 'rm', 'uninstall'];
    const cautionWords = ['network', '网络', 'api', 'download', 'install', '安装'];
    const lower = needed.toLowerCase();
    if (dangerWords.some(w => lower.includes(w))) return 'dangerous';
    if (cautionWords.some(w => lower.includes(w))) return 'caution';
    return 'safe';
  }
}
let _instance: GapDetector | null = null;
export function getGapDetector(): GapDetector { if (!_instance) _instance = new GapDetector(); return _instance; }
