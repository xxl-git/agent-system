"use strict";
// 项目管理闭环 — 类型定义 (3.7)
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROJECT_CONFIG = void 0;
exports.parseFrontmatter = parseFrontmatter;
exports.buildFrontmatter = buildFrontmatter;
exports.DEFAULT_PROJECT_CONFIG = {
    baseDir: './projects',
    autoSaveIntervalMs: 300000, // 5 min
    maxCheckpoints: 10,
    inactivityDaysToArchive: 7,
};
// Builder pattern — parse YAML frontmatter
function parseFrontmatter(content) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch)
        return { meta: {}, body: content };
    const meta = {};
    const fmLines = fmMatch[1].split('\n');
    for (const line of fmLines) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv)
            continue;
        const key = kv[1].trim();
        let value = kv[2].trim();
        // Type coercion
        if (value === 'true')
            value = true;
        else if (value === 'false')
            value = false;
        else if (value === 'null')
            value = null;
        else if (/^\d+(\.\d+)?$/.test(value))
            value = parseFloat(value);
        meta[key] = value;
    }
    return { meta, body: fmMatch[2] };
}
function buildFrontmatter(meta) {
    const lines = [
        `project: ${meta.project}`,
        `status: ${meta.status}`,
        `progress: ${meta.progress}`,
        `priority: ${meta.priority}`,
        `active: ${meta.active}`,
        `created: ${meta.created}`,
        `updated: ${meta.updated}`,
    ];
    if (meta.description)
        lines.push(`description: "${meta.description}"`);
    if (meta.tags) {
        const tagList = Array.isArray(meta.tags) ? meta.tags : String(meta.tags).split(/,\s*/);
        if (tagList.length > 0)
            lines.push(`tags: [${tagList.join(', ')}]`);
    }
    return `---\n${lines.join('\n')}\n---\n`;
}
//# sourceMappingURL=types.js.map