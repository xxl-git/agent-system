"use strict";
// PromptRegistry — 提示词模板注册表
// Phase 2: 统一管理所有模块的提示词模板，支持变量插值、热重载、模型感知
// 替换各模块内硬编码的 system prompt
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptRegistry = void 0;
exports.getPromptRegistry = getPromptRegistry;
exports.initPromptRegistry = initPromptRegistry;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
// ─── PromptRegistry ──────────────────────────────────────────────────────────
class PromptRegistry {
    templates = new Map();
    constructor() {
        this.registerBuiltins();
    }
    /**
     * 注册一个模板（覆盖已有同 id 的模板）
     */
    register(template) {
        this.templates.set(template.id, template);
        logger_1.logger.debug(`[PromptRegistry] 注册模板: ${template.id} v${template.version}`);
    }
    /**
     * 获取模板，支持变量插值
     * @param id 模板 ID
     * @param variables 插值变量 { key: value }
     */
    get(id, variables) {
        const tpl = this.templates.get(id);
        if (!tpl) {
            logger_1.logger.warn(`[PromptRegistry] 模板不存在: ${id}，返回空占位`);
            return { id, version: '0.0.0', system: '', user: '' };
        }
        if (!variables || Object.keys(variables).length === 0) {
            return tpl;
        }
        return {
            ...tpl,
            system: tpl.system ? interpolate(tpl.system, variables) : undefined,
            user: tpl.user ? interpolate(tpl.user, variables) : undefined,
        };
    }
    /**
     * 检查模板是否存在
     */
    has(id) {
        return this.templates.has(id);
    }
    /**
     * 列出所有模板 ID
     */
    list() {
        return Array.from(this.templates.keys());
    }
    /**
     * 从 config/prompts/ 目录加载 .md 文件（热重载）
     * 文件名即 id（如 intent.parse.md → id='intent.parse'）
     * 文件格式：
     *   ---
     *   version: "1.0.0"
     *   params: { temperature: 0 }
     *   ---
     *   <system prompt 内容>
     */
    loadFromDir(promptsDir) {
        if (!fs.existsSync(promptsDir)) {
            logger_1.logger.warn(`[PromptRegistry] 提示词目录不存在: ${promptsDir}`);
            return;
        }
        const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.md'));
        let loaded = 0;
        for (const file of files) {
            try {
                const id = file.replace(/\.md$/, '');
                const filePath = path.join(promptsDir, file);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const parsed = parseTemplateFile(id, raw);
                this.register(parsed);
                loaded++;
            }
            catch (err) {
                logger_1.logger.warn(`[PromptRegistry] 加载模板文件失败: ${file}`, err);
            }
        }
        logger_1.logger.info(`[PromptRegistry] 从目录加载了 ${loaded} 个模板: ${promptsDir}`);
    }
    // ─── 内置模板 ──────────────────────────────────────────────────────────────
    registerBuiltins() {
        // Agent 身份
        this.register({
            id: 'agent.identity',
            version: '2.1.0',
            taskType: 'chat',
            wrapper: 'structured',
            system: `You are an intelligent Agent assistant. You help users accomplish tasks efficiently and accurately.

Core principles:
- Reply concisely and directly. Avoid filler words.
- When executing tasks, break them into clear steps.
- If information is insufficient, ask for clarification before acting.
- Always confirm destructive operations before proceeding.
- Use Chinese (Simplified) when the user writes in Chinese.

## Capabilities

### Tools
- exec(command, workdir?) — execute system commands (30s timeout, dangerous commands blocked)
- write_file(path, content) — write files (auto-create parent directories, UTF-8)
- read_file(path) — read file contents (truncated at 5000 chars)
- web_search(keyword) — search the web for up-to-date information

### Subsystems
- Project management: projects/ directory (PROGRESS.md, JOURNAL.md, TODO.md, DESIGN.md)
- Memory store: file logs (memory/*.md) + SQLite DB (data/memory.db)
- Skill registry: data/skills/*.json, trigger-word matching
- Sub-agent: independent context for parallel/specialized tasks
- Experience store: cross-session, auto-extracted patterns and pitfalls

## Memory retrieval
When the user references past information:
1. [历史背景] block — injected at conversation start (cross-session recovery)
2. [相关经验] block — injected automatically when input matches past experiences
3. Daily logs: memory/*.md (keyword search, 30-day retention)
4. Structured memory: data/memory.db (decisions, entities, summaries, sessions)
5. Project files: projects/<name>/JOURNAL.md
If memory not found, tell the user honestly. Do not fabricate.

## Environment
Working directory: {{cwd}}
Active project: {{activeProject}}
Current model: {{modelName}}`,
        });
        // 记忆块包装（以 user 角色注入，不污染 system）
        this.register({
            id: 'agent.memory',
            version: '1.0.0',
            user: `以下是来自历史会话的背景信息，供参考：

{{memoryBlock}}

（以上是历史背景，不代表当前对话内容）`,
        });
        // 意图解析
        this.register({
            id: 'intent.parse',
            version: '1.0.0',
            taskType: 'intent',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 512, reasoning: 'off' },
            system: `你是一个意图分析器。分析用户消息，用 JSON 输出：
{
  "type": "chat|task|query|command",
  "summary": "用中文一句话总结用户意图",
  "entities": ["实体1", "实体2"],
  "confidence": 0.8,
  "needsClarification": false,
  "missingInfo": []
}

type 说明:
- chat: 闲聊、问候、感谢
- task: 要求做某件事（创建文件、运行程序等）
- query: 询问信息或知识
- command: 对系统的直接指令（退出、设置等）
- unknown: 无法判断

只输出 JSON，不要额外文字。`,
        });
        // 任务分解
        this.register({
            id: 'task.decompose',
            version: '1.0.0',
            taskType: 'decompose',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
            system: `你是一个任务分解器。将用户请求拆解成子任务 DAG，输出 JSON。

可用工具: {{availableTools}}

格式：
{
  "tasks": [{
    "id": "1",
    "title": "子任务标题",
    "description": "做什么",
    "tool": "工具名（可选）",
    "toolArgs": {"arg":"value"},
    "dependsOn": [],
    "estimatedMinutes": 1
  }],
  "parallelGroups": [["1"], ["2","3"], ["4"]]
}

只输出 JSON，不要额外文字。dependsOn 必须引用存在的 id。`,
        });
        // 上下文压缩摘要
        this.register({
            id: 'context.summarize',
            version: '1.0.0',
            taskType: 'summarize',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
            system: `你是一个对话摘要助手。请将以下对话历史浓缩为简短摘要，保留关键信息：
- 用户的主要需求和目标
- 已完成的重要步骤和决策
- 当前状态和未解决的问题

摘要用中文，100-300字。只输出摘要文本，不要额外格式。`,
        });
        // 会话摘要（记忆蒸馏）
        this.register({
            id: 'session.summarize',
            version: '1.0.0',
            taskType: 'summarize',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
            system: `你是一个记忆摘要提取器。从对话中提取结构化知识，以 JSON 输出：
{
  "sessionSummary": "会话一句话摘要",
  "keyDecisions": [{"category": "技术选型", "summary": "选择了X", "detail": "原因..."}],
  "learnedFacts": ["用户的项目是..."],
  "entityUpdates": [{"name": "项目A", "type": "project", "notes": "..."}],
  "tags": ["typescript", "agent"],
  "nextSteps": ["完成功能X"],
  "knowledgePoints": ["下次会话需要知道的要点"]
}

只输出 JSON，不要额外文字。`,
        });
        // 上下文摘要块包装（以 user 角色注入，不塞进 system）
        this.register({
            id: 'context.summary-block',
            version: '1.0.0',
            user: `[此前对话摘要]
{{summary}}
[摘要结束]`,
        });
        // 经验提取
        this.register({
            id: 'experience.extract',
            version: '1.0.0',
            taskType: 'summarize',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 512, reasoning: 'off' },
            system: `You are an experience extractor. Analyze the task execution below and extract a structured experience record that can be reused in future similar situations.

Return ONLY a JSON object (no markdown, no backticks):
{
  "scenario": "简短场景描述",
  "problem": "遇到了什么问题",
  "solution": "怎么解决的",
  "reasoning": "为什么有效",
  "tags": ["tag1", "tag2"],
  "type": "pattern"
}

type: pattern (成功模式) | pitfall (踩坑教训) | tip (通用建议)
如果任务很普通，返回 {"type": "tip", "scenario": "N/A", ...}
只输出 JSON。`,
        });
        // 经验精炼（用户手动录入时加工）
        this.register({
            id: 'experience.refine',
            version: '1.0.0',
            taskType: 'summarize',
            wrapper: 'minimal',
            params: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
            system: `You are an experience refiner. Transform the user's raw description into a clean, generalized, reusable experience record.

Return ONLY a JSON object (no markdown, no backticks):
{
  "scenario": "通用场景描述（去掉具体变量值、时间、路径）",
  "problem": "遇到了什么问题（1-3 句话）",
  "solution": "怎么解决的（1-3 句话，含关键步骤）",
  "reasoning": "为什么有效（1-2 句话）",
  "tags": ["tag1", "tag2"],
  "type": "pattern",
  "outcome": "success"
}

type: pattern (成功模式) | pitfall (踩坑教训) | tip (通用建议)
outcome: success | failure

泛化规则（最重要）:
- scenario 必须通用，去掉具体变量值、时间、路径
- tags 用英文小写，3-5 个
- 如果太模糊无法提炼，scenario 填 "N/A"
只输出 JSON。`,
        });
        logger_1.logger.debug(`[PromptRegistry] 内置模板注册完成，共 ${this.templates.size} 个`);
    }
}
exports.PromptRegistry = PromptRegistry;
// ─── 工具函数 ────────────────────────────────────────────────────────────────
/**
 * 变量插值：{{variableName}} → value
 */
function interpolate(template, variables) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (key in variables)
            return variables[key];
        logger_1.logger.warn(`[PromptRegistry] 插值变量未提供: {{${key}}}`);
        return `{{${key}}}`;
    });
}
/**
 * 解析模板文件（YAML frontmatter + markdown body）
 * 支持格式：
 *   ---
 *   version: "1.0.0"
 *   params:
 *     temperature: 0
 *   ---
 *   系统提示词内容
 */
function parseTemplateFile(id, raw) {
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
        // 无 frontmatter，整个文件作为 system prompt
        return {
            id,
            version: '1.0.0',
            system: raw.trim(),
        };
    }
    const frontmatterStr = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    // 简单解析 frontmatter（避免引入 js-yaml 依赖，用正则处理常见格式）
    const fm = {};
    const versionMatch = frontmatterStr.match(/version:\s*["']?([^"'\n]+)["']?/);
    if (versionMatch)
        fm.version = versionMatch[1].trim();
    const wrapperMatch = frontmatterStr.match(/wrapper:\s*["']?(minimal|structured|verbose)["']?/);
    if (wrapperMatch)
        fm.wrapper = wrapperMatch[1];
    const taskTypeMatch = frontmatterStr.match(/taskType:\s*["']?(\w+)["']?/);
    if (taskTypeMatch)
        fm.taskType = taskTypeMatch[1];
    // 解析 params 块（简单格式）
    const paramsMatch = frontmatterStr.match(/params:\n((?:[ \t]+\w+:[ \t]*[^\n]+\n?)+)/);
    if (paramsMatch) {
        const paramsStr = paramsMatch[1];
        const params = {};
        const tempMatch = paramsStr.match(/temperature:\s*([\d.]+)/);
        if (tempMatch)
            params.temperature = parseFloat(tempMatch[1]);
        const tokensMatch = paramsStr.match(/max_tokens:\s*(\d+)/);
        if (tokensMatch)
            params.max_tokens = parseInt(tokensMatch[1], 10);
        const reasoningMatch = paramsStr.match(/reasoning:\s*["']?(\w+)["']?/);
        if (reasoningMatch)
            params.reasoning = reasoningMatch[1];
        fm.params = params;
    }
    return {
        id,
        version: fm.version || '1.0.0',
        system: body,
        wrapper: fm.wrapper,
        params: fm.params,
        taskType: fm.taskType,
    };
}
// ─── 单例 ────────────────────────────────────────────────────────────────────
let _instance = null;
function getPromptRegistry() {
    if (!_instance) {
        _instance = new PromptRegistry();
    }
    return _instance;
}
/** 从目录初始化（会自动加载内置模板 + 外部文件，外部文件覆盖内置） */
function initPromptRegistry(promptsDir) {
    _instance = new PromptRegistry();
    if (promptsDir) {
        _instance.loadFromDir(promptsDir);
    }
    return _instance;
}
//# sourceMappingURL=registry.js.map