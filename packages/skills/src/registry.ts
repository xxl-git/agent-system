import * as fs from 'fs';
import * as path from 'path';
import type { SkillMeta } from './types';
import { logger } from './logger';

export class SkillRegistry {
  private registry: Map<string, SkillMeta> = new Map();
  private skillsDir: string;
  constructor(skillsDir: string = './data/skills') {
    this.skillsDir = path.resolve(skillsDir);
    if (!fs.existsSync(this.skillsDir)) fs.mkdirSync(this.skillsDir, { recursive: true });
    this.loadAll();
  }
  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) return;
    const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(this.skillsDir, file), 'utf-8');
        const skill = JSON.parse(data) as SkillMeta;
        if (skill.status === 'active') this.registry.set(skill.name, skill);
      } catch (err) { logger.warn(`[Skill] 解析失败: ${file}`); }
    }
    logger.info(`[Skill] 加载了 ${this.registry.size} 个技能`);
  }
  register(skill: SkillMeta): void {
    this.registry.set(skill.name, skill); this.save(skill);
    logger.info(`[Skill] ✅ 技能已注册: ${skill.name} v${skill.version}`);
  }
  get(name: string): SkillMeta | undefined { return this.registry.get(name); }
  findByTrigger(input: string): SkillMeta[] {
    const matches: SkillMeta[] = [];
    const lower = input.toLowerCase();
    for (const skill of this.registry.values()) {
      if (skill.triggers.some(t => lower.includes(t.toLowerCase()))) matches.push(skill);
    }
    return matches;
  }
  findByCapability(capabilityName: string): SkillMeta[] {
    return Array.from(this.registry.values()).filter(s => s.capabilities.some(c => c.name === capabilityName));
  }
  has(name: string): boolean { return this.registry.has(name); }
  overlap(newSkill: SkillMeta): { name: string; overlap: number } | null {
    for (const existing of this.registry.values()) {
      if (existing.name === newSkill.name) return { name: existing.name, overlap: 1 };
      const shared = newSkill.capabilities.filter(nc => existing.capabilities.some(ec => ec.name === nc.name));
      if (shared.length > 0) {
        const overlapPct = shared.length / Math.max(newSkill.capabilities.length, existing.capabilities.length);
        if (overlapPct > 0.8) return { name: existing.name, overlap: overlapPct };
      }
    }
    return null;
  }
  list(): string[] {
    return Array.from(this.registry.entries()).map(([name, skill]) => {
      const successRate = skill.stats.totalCalls > 0 ? (skill.stats.successCalls / skill.stats.totalCalls * 100).toFixed(0) : 'N/A';
      return `${skill.status === 'active' ? '✅' : '❌'} ${name} v${skill.version} | ${skill.stats.totalCalls}次 | ${successRate}% | ${skill.dangerLevel}`;
    });
  }
  recordCall(name: string, success: boolean, durationMs: number): void {
    const skill = this.registry.get(name); if (!skill) return;
    skill.stats.totalCalls++; if (success) skill.stats.successCalls++; else skill.stats.failCalls++;
    skill.stats.avgDurationMs = (skill.stats.avgDurationMs * (skill.stats.totalCalls - 1) + durationMs) / skill.stats.totalCalls;
    this.save(skill);
  }
  disable(name: string): void {
    const skill = this.registry.get(name); if (!skill) return;
    skill.status = 'disabled'; this.save(skill); this.registry.delete(name);
    logger.warn(`[Skill] ⏸️ 技能已禁用: ${name}`);
  }
  get size(): number { return this.registry.size; }
  private save(skill: SkillMeta): void {
    fs.writeFileSync(path.join(this.skillsDir, `${skill.name}.json`), JSON.stringify(skill, null, 2), 'utf-8');
  }
}
let _instance: SkillRegistry | null = null;
export function getRegistry(): SkillRegistry { if (!_instance) _instance = new SkillRegistry(); return _instance; }
