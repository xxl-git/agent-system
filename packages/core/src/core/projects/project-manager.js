"use strict";
// 项目管理闭环 — 核心实现 (3.7)
// 职责：接任务→澄清→设计→执行→检查点→日报→跨会话恢复
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectManager = void 0;
exports.getProjectManager = getProjectManager;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = __importDefault(require("../../logger"));
const types_1 = require("./types");
class ProjectManager {
    config;
    activeProject = null;
    checkpoints = new Map();
    constructor(config) {
        this.config = { ...types_1.DEFAULT_PROJECT_CONFIG, ...config };
    }
    // ===== 项目 CRUD =====
    /** 创建新项目 */
    createProject(name, meta) {
        const projectDir = this.projectDir(name);
        if (fs.existsSync(projectDir)) {
            logger_1.default.warn(`项目 ${name} 已存在，返回现有元数据`);
            return this.getProjectMeta(name);
        }
        fs.mkdirSync(projectDir, { recursive: true });
        const now = new Date().toISOString();
        const project = {
            project: name,
            status: 'in_progress',
            progress: 0,
            priority: meta.priority || 'P1',
            checkpoint: null,
            active: true,
            created: now,
            updated: now,
            description: meta.description,
            tags: meta.tags,
        };
        // 写空项目文件（含 frontmatter）
        this.writeProjectFile(name, 'PROGRESS.md', this.buildProgressDoc(project));
        this.writeProjectFile(name, 'JOURNAL.md', (0, types_1.buildFrontmatter)(project) + '\n# 执行日报\n\n');
        this.writeProjectFile(name, 'TODO.md', (0, types_1.buildFrontmatter)(project) + '\n# 待办清单\n\n');
        this.writeProjectFile(name, 'DESIGN.md', (0, types_1.buildFrontmatter)(project) + '\n# 设计方案\n\n待填写...\n');
        // 如果有活跃项目，先停用它
        if (this.activeProject && this.activeProject !== name) {
            this.setActive(name, false);
        }
        this.activeProject = name;
        logger_1.default.info(`[Project] 创建项目: ${name}`);
        return project;
    }
    /** 获取项目元数据 */
    getProjectMeta(name) {
        const progressFile = path.join(this.projectDir(name), 'PROGRESS.md');
        if (!fs.existsSync(progressFile)) {
            throw new Error(`项目 ${name} 不存在 (缺少 PROGRESS.md)`);
        }
        const raw = fs.readFileSync(progressFile, 'utf-8');
        const { meta } = (0, types_1.parseFrontmatter)(raw);
        // 兜底默认值
        return {
            project: name,
            status: meta.status || 'in_progress',
            progress: meta.progress || 0,
            priority: meta.priority || 'P1',
            checkpoint: meta.checkpoint || null,
            active: meta.active !== false,
            created: meta.created || 'unknown',
            updated: meta.updated || 'unknown',
            description: meta.description,
            tags: meta.tags,
        };
    }
    /** 更新项目元数据 */
    updateProjectMeta(name, patch) {
        const meta = this.getProjectMeta(name);
        const updated = { ...meta, ...patch, updated: new Date().toISOString() };
        this.writeProgressDoc(name, updated);
        logger_1.default.debug(`[Project] 更新 ${name}: ${Object.keys(patch).join(', ')}`);
        return updated;
    }
    /** 列出所有项目 */
    listProjects() {
        if (!fs.existsSync(this.config.baseDir))
            return [];
        const dirs = fs.readdirSync(this.config.baseDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        return dirs.map(name => {
            try {
                return this.getProjectMeta(name);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    /** 获取活跃项目 */
    getActiveProject() {
        if (!this.activeProject) {
            // 从文件系统查找 active 项目
            const projects = this.listProjects();
            const active = projects.find(p => p.active);
            if (active)
                this.activeProject = active.project;
            return active || null;
        }
        try {
            return this.getProjectMeta(this.activeProject);
        }
        catch {
            this.activeProject = null;
            return null;
        }
    }
    /** 切换活跃项目 */
    setActive(name, active) {
        if (active && this.activeProject && this.activeProject !== name) {
            this.updateProjectMeta(this.activeProject, { active: false });
        }
        this.updateProjectMeta(name, { active });
        this.activeProject = active ? name : null;
        logger_1.default.info(`[Project] ${active ? '激活' : '停用'} 项目: ${name}`);
    }
    // ===== 检查点 =====
    /** 保存检查点 */
    saveCheckpoint(projectName, sessionId, dagSnapshot, completed, lastSubtask) {
        const cp = {
            savedAt: new Date().toISOString(),
            sessionId,
            lastSubtask,
            completed,
            dagSnapshot,
        };
        // 内存缓存
        if (!this.checkpoints.has(projectName)) {
            this.checkpoints.set(projectName, []);
        }
        const cps = this.checkpoints.get(projectName);
        cps.push(cp);
        if (cps.length > this.config.maxCheckpoints)
            cps.shift();
        // 写入项目元数据
        const meta = this.getProjectMeta(projectName);
        this.updateProjectMeta(projectName, { checkpoint: cp, status: 'paused' });
        // 序列化到磁盘
        const cpFile = path.join(this.projectDir(projectName), 'checkpoint.json');
        fs.writeFileSync(cpFile, JSON.stringify(cp, null, 2), 'utf-8');
        logger_1.default.info(`[Project] 💾 检查点已保存: ${projectName} (任务 ${completed.length}/${lastSubtask})`);
        return cp;
    }
    /** 恢复检查点 */
    restoreCheckpoint(projectName) {
        const cpFile = path.join(this.projectDir(projectName), 'checkpoint.json');
        if (!fs.existsSync(cpFile)) {
            logger_1.default.debug(`[Project] 无检查点: ${projectName}`);
            return null;
        }
        const cp = JSON.parse(fs.readFileSync(cpFile, 'utf-8'));
        this.updateProjectMeta(projectName, {
            status: 'in_progress',
            checkpoint: cp,
        });
        logger_1.default.info(`[Project] 📂 检查点恢复: ${projectName} (${cp.completed.length} 已完成)`);
        return cp;
    }
    // ===== 日报 =====
    /** 写日报 */
    writeJournal(projectName, entry) {
        const journalFile = path.join(this.projectDir(projectName), 'JOURNAL.md');
        const existing = fs.existsSync(journalFile)
            ? fs.readFileSync(journalFile, 'utf-8')
            : '';
        const fm = (0, types_1.buildFrontmatter)(this.getProjectMeta(projectName));
        const resultIcon = entry.result === 'success' ? '✅' : entry.result === 'partial' ? '⚠️' : '❌';
        const entryMd = [
            `### ${entry.timestamp.split('T')[0]} ${entry.timestamp.split('T')[1]?.slice(0, 5) || ''}`,
            `- **操作**: ${entry.action}`,
            `- **结果**: ${resultIcon} ${entry.result}`,
            `- **下一步**: ${entry.next}`,
            entry.notes ? `- **备注**: ${entry.notes}` : '',
            '',
        ].filter(Boolean).join('\n');
        // 如果文件已有 frontmatter，替换它
        const bodyContent = existing.replace(/^---\n[\s\S]*?\n---\n/, '');
        fs.writeFileSync(journalFile, fm + bodyContent + entryMd, 'utf-8');
        logger_1.default.debug(`[Project] 📝 日报: ${projectName}`);
    }
    // ===== TODO =====
    /** 添加待办 */
    addTodo(projectName, item) {
        const todo = {
            ...item,
            id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            createdAt: new Date().toISOString(),
        };
        const todoFile = path.join(this.projectDir(projectName), 'TODO.md');
        const existing = fs.existsSync(todoFile)
            ? fs.readFileSync(todoFile, 'utf-8')
            : '';
        const fm = (0, types_1.buildFrontmatter)(this.getProjectMeta(projectName));
        const bodyContent = existing.replace(/^---\n[\s\S]*?\n---\n/, '');
        const priorityIcon = todo.priority === 'P0' ? '🔴' : todo.priority === 'P1' ? '🟡' : '🟢';
        const statusIcon = todo.status === 'done' ? '✅' : todo.status === 'in_progress' ? '🔄' : todo.status === 'blocked' ? '🚫' : '⬜';
        const todoLine = `- ${statusIcon} ${priorityIcon} **${todo.title}** (${todo.status}) \`${todo.id}\`\n`;
        fs.writeFileSync(todoFile, fm + bodyContent + todoLine, 'utf-8');
        return todo;
    }
    /** 更新待办状态 */
    updateTodo(projectName, todoId, status) {
        const todoFile = path.join(this.projectDir(projectName), 'TODO.md');
        if (!fs.existsSync(todoFile))
            return;
        let content = fs.readFileSync(todoFile, 'utf-8');
        // 简单替换状态文本
        const regex = new RegExp(`\\((${['pending', 'in_progress', 'done', 'blocked'].join('|')})\\) \`${todoId}\``, 'g');
        content = content.replace(regex, `(${status}) \`${todoId}\``);
        fs.writeFileSync(todoFile, content, 'utf-8');
        // 同步更新进度
        this.recalculateProgress(projectName);
    }
    // ===== 进度计算 =====
    recalculateProgress(projectName) {
        const todoFile = path.join(this.projectDir(projectName), 'TODO.md');
        if (!fs.existsSync(todoFile))
            return 0;
        const content = fs.readFileSync(todoFile, 'utf-8');
        const total = (content.match(/^\s*-\s+./gm) || []).length;
        const done = (content.match(/\(done\)/g) || []).length;
        const progress = total > 0 ? Math.round((done / total) * 100) : 0;
        this.updateProjectMeta(projectName, { progress });
        return progress;
    }
    // ===== 会话恢复 =====
    /** 生成恢复摘要（用户新会话时展示） */
    recoverySummary() {
        const active = this.getActiveProject();
        if (!active)
            return '';
        const checkpoint = active.checkpoint;
        const lines = [];
        lines.push(`\n📂 **恢复项目**: ${active.project}`);
        lines.push(`   状态: ${active.status} | 进度: ${active.progress}% | 优先级: ${active.priority}`);
        if (checkpoint && checkpoint.completed.length > 0) {
            lines.push(`   💾 上次检查点: ${checkpoint.savedAt}`);
            lines.push(`   已完成 ${checkpoint.completed.length} 个子任务，停在步骤 ${checkpoint.lastSubtask}`);
        }
        // 读最近日报
        const journalFile = path.join(this.projectDir(active.project), 'JOURNAL.md');
        if (fs.existsSync(journalFile)) {
            const journal = fs.readFileSync(journalFile, 'utf-8');
            const entries = journal.match(/###\s+\d{4}-\d{2}-\d{2}.*$/gm);
            if (entries && entries.length > 0) {
                const lastEntry = entries.slice(-1)[0].split('\n').slice(0, 3).join('\n');
                lines.push(`   📝 最近日报:\n${lastEntry}`);
            }
        }
        return lines.join('\n');
    }
    // ===== 工具方法 =====
    projectDir(name) {
        return path.resolve(this.config.baseDir, name);
    }
    writeProjectFile(project, filename, content) {
        const dir = this.projectDir(project);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
    }
    writeProgressDoc(name, meta) {
        const content = this.buildProgressDoc(meta);
        this.writeProjectFile(name, 'PROGRESS.md', content);
    }
    buildProgressDoc(meta) {
        const fm = (0, types_1.buildFrontmatter)(meta);
        const statusEmoji = meta.status === 'in_progress' ? '🔄' :
            meta.status === 'paused' ? '⏸️' : meta.status === 'completed' ? '✅' : '📦';
        const barLen = 20;
        const filledLen = Math.round((meta.progress / 100) * barLen);
        const bar = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);
        return fm + [
            `# ${meta.project} 进度`,
            '',
            `> ${statusEmoji} ${meta.status} | ${meta.priority} | ${meta.progress}%`,
            '',
            `\`${bar}\``,
            '',
            meta.description ? `> ${meta.description}\n` : '',
            `创建: ${meta.created}`,
            `更新: ${meta.updated}`,
            '',
        ].join('\n');
    }
}
exports.ProjectManager = ProjectManager;
// 单例
let _instance = null;
function getProjectManager(config) {
    if (!_instance) {
        _instance = new ProjectManager(config);
    }
    return _instance;
}
//# sourceMappingURL=project-manager.js.map