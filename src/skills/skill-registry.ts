// 技能注册表 — 管理技能的安装/加载/卸载/版本
import * as fs from 'fs';
import * as path from 'path';
import logger from '../logger';

export interface SkillMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  category: 'productivity' | 'dev_tools' | 'data' | 'communication' | 'automation' | 'custom';
  author: string;
  dependencies: string[];
  entry: string;          // 相对路径到技能入口文件
  enabled: boolean;
  installedAt: string;
}

export interface SkillContext {
  /** 技能可访问的 agent 功能 */
  sendMessage: (text: string) => Promise<string>;
  getStatus: () => any;
  log: (msg: string) => void;
  /** 技能数据存储路径 */
  dataDir: string;
}

export interface SkillInstance {
  meta: SkillMeta;
  /** 执行技能 */
  execute?(ctx: SkillContext, input: string): Promise<string>;
  /** 安装回调 */
  onInstall?(ctx: SkillContext): Promise<void>;
  /** 卸载回调 */
  onUninstall?(): Promise<void>;
}

export class SkillRegistry {
  private skillsDir: string;
  private skills: Map<string, SkillInstance> = new Map();
  private registryFile: string;

  constructor(skillsDir?: string) {
    this.skillsDir = path.resolve(skillsDir || process.cwd(), 'skills');
    this.registryFile = path.join(this.skillsDir, 'registry.json');
  }

  /** 初始化：加载已安装的技能 */
  async init(): Promise<number> {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }

    // 加载注册表
    if (fs.existsSync(this.registryFile)) {
      try {
        const metas: SkillMeta[] = JSON.parse(fs.readFileSync(this.registryFile, 'utf-8'));
        for (const meta of metas) {
          if (meta.enabled) await this.load(meta);
        }
        logger.info(`[Skill] 加载了 ${this.skills.size} 个技能`);
      } catch (err) {
        logger.warn('[Skill] 注册表解析失败', err);
      }
    }

    return this.skills.size;
  }

  /** 加载单个技能 */
  async load(meta: SkillMeta): Promise<boolean> {
    try {
      const entryPath = path.join(this.skillsDir, meta.id, meta.entry);
      if (!fs.existsSync(entryPath)) {
        logger.warn(`[Skill] ${meta.id}: 入口文件不存在 ${entryPath}`);
        return false;
      }

      // 动态加载技能模块
      const mod = require(entryPath);
      const instance: SkillInstance = {
        meta,
        execute: mod.default || mod.execute,
        onInstall: mod.onInstall,
        onUninstall: mod.onUninstall,
      };

      this.skills.set(meta.id, instance);
      logger.info(`[Skill] ✓ ${meta.name} v${meta.version}`);
      return true;
    } catch (err) {
      logger.warn(`[Skill] ${meta.id}: 加载失败`, err);
      return false;
    }
  }

  /** 安装技能（从 meta 创建目录+文件，然后加载） */
  async install(meta: SkillMeta, sourceCode: string): Promise<boolean> {
    const skillDir = path.join(this.skillsDir, meta.id);
    fs.mkdirSync(skillDir, { recursive: true });

    // 写入入口文件
    const entryPath = path.join(skillDir, meta.entry);
    fs.writeFileSync(entryPath, sourceCode, 'utf-8');

    // 写入 meta
    fs.writeFileSync(path.join(skillDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // 更新注册表
    await this.load(meta);
    await this.saveRegistry();
    logger.info(`[Skill] 安装完成: ${meta.name} v${meta.version}`);
    return true;
  }

  /** 卸载技能 */
  uninstall(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;

    // 调用卸载回调
    skill.onUninstall?.();
    this.skills.delete(id);

    // 删除目录
    const skillDir = path.join(this.skillsDir, id);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    this.saveRegistry();
    logger.info(`[Skill] 卸载: ${id}`);
    return true;
  }

  /** 列出所有技能 */
  list(): SkillMeta[] {
    return Array.from(this.skills.values()).map(s => s.meta);
  }

  /** 获取技能 */
  get(id: string): SkillInstance | undefined {
    return this.skills.get(id);
  }

  /** 检测能力缺口 */
  detectGaps(requestedAbility: string): string[] {
    const gaps: string[] = [];
    // 简单关键词匹配
    const keywords: Record<string, string[]> = {
      'translate': ['翻译', 'translate', '翻译技能'],
      'weather': ['天气', 'weather', '气象'],
      'search': ['搜索', 'search', 'web_search'],
      'file': ['文件', 'file', '文件管理'],
      'code': ['代码', 'code', '编程', 'git'],
      'email': ['邮件', 'email', 'mail', '发邮件'],
      'database': ['数据库', 'database', 'sql', 'db'],
      'chart': ['图表', 'chart', '可视化', 'visualization'],
    };

    for (const [skill, terms] of Object.entries(keywords)) {
      if (terms.some(t => requestedAbility.includes(t)) && !this.skills.has(skill)) {
        gaps.push(skill);
      }
    }

    return gaps;
  }

  /** 技能计数 */
  get count(): number { return this.skills.size; }

  private async saveRegistry(): Promise<void> {
    const metas = this.list();
    fs.writeFileSync(this.registryFile, JSON.stringify(metas, null, 2), 'utf-8');
  }
}

let _registry: SkillRegistry | null = null;
export function getSkillRegistry(): SkillRegistry {
  if (!_registry) _registry = new SkillRegistry();
  return _registry;
}
