"use strict";
// ExperienceRetriever — 经验检索器
// 三层降级检索：标签精确 → 关键词模糊 → 语义匹配（暂不实现 embedding）
// 按 score 排序取 Top-K
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExperienceRetriever = void 0;
exports.getExperienceRetriever = getExperienceRetriever;
const store_1 = require("./store");
const logger_1 = __importDefault(require("../logger"));
// ─── ExperienceRetriever ─────────────────────────────────────────────────────
class ExperienceRetriever {
    store = (0, store_1.getExperienceStore)();
    /**
     * 检索与用户输入最相关的经验
     *
     * @param userInput 用户当前输入
     * @param opts 检索选项
     * @returns Top-K 相关经验（按相关度+评分排序）
     */
    retrieve(userInput, opts) {
        const topK = opts?.topK ?? 3;
        const activeOnly = opts?.activeOnly ?? true;
        const all = this.store.getActive();
        if (all.length === 0)
            return [];
        // 三层匹配
        const results = [];
        for (const rec of all) {
            const match = this.matchScore(userInput, rec);
            if (match.score > 0) {
                results.push({
                    record: rec,
                    matchReason: match.reason,
                    matchScore: match.score,
                });
            }
        }
        // 排序：matchScore * record.score 综合排序
        results.sort((a, b) => {
            const aCombined = a.matchScore * a.record.score;
            const bCombined = b.matchScore * b.record.score;
            return bCombined - aCombined;
        });
        const top = results.slice(0, topK);
        if (top.length > 0) {
            logger_1.default.debug(`[ExperienceRetriever] "${userInput.slice(0, 50)}" → 匹配 ${results.length} 条，取 Top-${top.length}` +
                ` (${top.map(t => `#${t.record.id}:${t.matchReason}`).join(', ')})`);
        }
        return top;
    }
    /**
     * 将检索结果格式化为可注入的文本块
     */
    formatBlock(results) {
        if (results.length === 0)
            return '';
        const lines = ['[相关经验]'];
        results.forEach((r, i) => {
            const rec = r.record;
            const typeLabel = rec.type === 'pattern' ? '成功模式' : rec.type === 'pitfall' ? '踩坑教训' : '建议';
            const scoreLabel = rec.reuseCount > 0
                ? `评分 ${rec.score.toFixed(2)} (复用 ${rec.reuseCount} 次，成功 ${rec.successCount} 次)`
                : `评分 ${rec.score.toFixed(2)} (新经验)`;
            lines.push(`${i + 1}. [${typeLabel}] 场景：${rec.scenario}`);
            lines.push(`   问题：${rec.problem}`);
            lines.push(`   解法：${rec.solution}`);
            if (rec.reasoning && rec.reasoning !== 'N/A') {
                lines.push(`   原因：${rec.reasoning}`);
            }
            lines.push(`   ${scoreLabel}`);
        });
        lines.push('[经验结束]');
        return lines.join('\n');
    }
    // ─── 匹配算法 ──────────────────────────────────────────────────────────────
    matchScore(userInput, rec) {
        const input = userInput.toLowerCase();
        let bestScore = 0;
        let bestReason = '';
        // 层 1: 标签精确匹配
        const tagScore = this.tagMatch(input, rec.tags);
        if (tagScore > 0) {
            if (tagScore > bestScore) {
                bestScore = tagScore;
                bestReason = `tag-match(${rec.tags.filter(t => input.includes(t.toLowerCase())).join(',')})`;
            }
        }
        // 层 2: 关键词匹配（scenario + problem + solution）
        const keywordScore = this.keywordMatch(input, rec);
        if (keywordScore > bestScore) {
            bestScore = keywordScore;
            bestReason = `keyword-match`;
        }
        // 层 3: 场景直接包含
        if (rec.scenario && input.includes(rec.scenario.toLowerCase())) {
            const scenarioScore = 0.9;
            if (scenarioScore > bestScore) {
                bestScore = scenarioScore;
                bestReason = `scenario-direct-match`;
            }
        }
        return { score: bestScore, reason: bestReason };
    }
    tagMatch(input, tags) {
        if (tags.length === 0)
            return 0;
        let hits = 0;
        for (const tag of tags) {
            if (input.includes(tag.toLowerCase()))
                hits++;
        }
        return hits === 0 ? 0 : 0.6 + (hits / tags.length) * 0.3; // 0.6 - 0.9
    }
    keywordMatch(input, rec) {
        const fields = [rec.scenario, rec.problem, rec.solution].join(' ').toLowerCase();
        const words = this.tokenize(input);
        if (words.length === 0)
            return 0;
        let hits = 0;
        for (const word of words) {
            if (word.length < 2)
                continue; // 跳过单字
            if (fields.includes(word))
                hits++;
        }
        if (hits === 0)
            return 0;
        return Math.min(0.5 + (hits / words.length) * 0.3, 0.8); // 0.5 - 0.8
    }
    tokenize(text) {
        // 简单分词：英文按空格/标点，中文按字
        const english = text.match(/[a-z]{2,}/g) || [];
        const chinese = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
        return [...english, ...chinese];
    }
}
exports.ExperienceRetriever = ExperienceRetriever;
// ─── 单例 ────────────────────────────────────────────────────────────────────
let _instance = null;
function getExperienceRetriever() {
    if (!_instance) {
        _instance = new ExperienceRetriever();
    }
    return _instance;
}
//# sourceMappingURL=retriever.js.map