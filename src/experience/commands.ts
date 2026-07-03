// ExperienceCommandHandler — 经验管理命令处理器
// 处理所有 /exp 子命令，支持用户主动录入、查看、修改、删除经验
//
// 核心 UX 流程（录入/修改）:
//   1. 用户 /exp add <描述>  →  Agent LLM 加工为泛化草稿  →  展示给用户
//   2. 用户 /exp confirm     →  确认保存（含去重检查）
//   用户 /exp cancel     →  放弃草稿
//
// 修改流程复用录入流程:
//   1. 用户 /exp edit <id>   →  加载已有经验 → LLM 加工为草稿 → 展示
//   2. 用户 /exp confirm     →  更新已有经验

import { getExperienceStore } from '@agent-system/experience';
import { getExperienceExtractor } from '@agent-system/experience';
import { getExperienceRetriever } from '@agent-system/experience';
import type { ExtractedExperience, RetrieveResult, ExperienceRecord, ExperienceInput } from '@agent-system/experience';

// ─── 草稿状态 ─────────────────────────────────────────────────────────────────

interface ExperienceDraft {
  /** LLM 加工后的草稿内容 */
  draft: ExtractedExperience;
  /** 编辑模式下，要更新的经验 ID */
  editId?: number;
  /** 检索到的相似经验（去重参考） */
  similar: RetrieveResult[];
  /** 原始用户输入 */
  rawText: string;
}

// ─── ExperienceCommandHandler ─────────────────────────────────────────────────

export class ExperienceCommandHandler {
  private _draft: ExperienceDraft | null = null;

  /**
   * 处理 /exp 子命令
   * @returns 回复给用户的文本
   */
  async handle(args: string[]): Promise<string> {
    const sub = args[0] || 'help';

    switch (sub) {
      case 'add':
        return this.handleAdd(args.slice(1).join(' '));
      case 'confirm':
        return this.handleConfirm();
      case 'cancel':
        return this.handleCancel();
      case 'list':
        return this.handleList(args[1]);
      case 'view':
        return this.handleView(args[1]);
      case 'search':
        return this.handleSearch(args.slice(1).join(' '));
      case 'edit':
        return this.handleEdit(args[1]);
      case 'delete':
        return this.handleDelete(args[1]);
      case 'stats':
        return this.handleStats();
      case 'help':
      default:
        return this.handleHelp();
    }
  }

  /** 当前是否有待确认的草稿 */
  hasDraft(): boolean {
    return this._draft !== null;
  }

  // ─── 录入流程 ──────────────────────────────────────────────────────────────

  private async handleAdd(rawText: string): Promise<string> {
    if (!rawText.trim()) {
      return '用法: /exp add <经验描述>\n' +
        '示例: /exp add 我发现 LM Studio 超时的时候重试三次就行了';
    }

    if (this._draft) {
      return '⚠️ 当前已有待确认的经验草稿，请先 /exp confirm 或 /exp cancel';
    }

    const extractor = getExperienceExtractor();
    const { draft, similar } = await extractor.refine(rawText);

    this._draft = { draft, similar, rawText };

    return this.formatDraft(draft, similar, false);
  }

  private handleConfirm(): string {
    if (!this._draft) {
      return '没有待确认的经验草稿。使用 /exp add 录入新经验。';
    }

    const { draft, editId, similar } = this._draft;
    const store = getExperienceStore();

    // 去重检查：如果相似度 > 0.85 的经验存在，提示合并而非新建
    const highSimilarity = similar.filter(s => s.matchScore > 0.85);
    if (highSimilarity.length > 0 && !editId) {
      const dup = highSimilarity[0];
      this._draft = null;
      return `⚠️ 发现高度相似的经验 #${dup.record.id}（相似度 ${(dup.matchScore * 100).toFixed(0)}%）:\n` +
        `   场景: ${dup.record.scenario}\n` +
        `   问题: ${dup.record.problem}\n\n` +
        `如要合并复用，请使用: /exp merge ${dup.record.id}\n` +
        `如确认为不同经验，请重新 /exp add 并补充更多细节区分。`;
    }

    const input: ExperienceInput = {
      scenario: draft.scenario,
      problem: draft.problem,
      solution: draft.solution,
      reasoning: draft.reasoning,
      tags: draft.tags,
      outcome: 'success',
      type: draft.type,
      source: 'user',
    };

    if (editId) {
      // 更新已有经验
      const ok = store.update(editId, input);
      this._draft = null;
      if (ok) {
        return `✅ 经验 #${editId} 已更新:\n   场景: ${draft.scenario}`;
      }
      return `❌ 更新失败: 经验 #${editId} 不存在`;
    }

    // 新建经验
    const id = store.save(input);
    this._draft = null;
    return `✅ 经验已保存 #${id}:\n   场景: ${draft.scenario}\n   类型: ${draft.type}\n   标签: [${draft.tags.join(', ')}]`;
  }

  private handleCancel(): string {
    if (!this._draft) {
      return '没有待确认的草稿。';
    }
    this._draft = null;
    return '已取消经验草稿。';
  }

  // ─── 编辑流程（复用录入的加工+确认机制）────────────────────────────────────

  private async handleEdit(idStr: string): Promise<string> {
    const id = parseInt(idStr, 10);
    if (!id) {
      return '用法: /exp edit <id>\n示例: /exp edit 5';
    }

    if (this._draft) {
      return '⚠️ 当前已有待确认的经验草稿，请先 /exp confirm 或 /exp cancel';
    }

    const store = getExperienceStore();
    const rec = store.getById(id);
    if (!rec) {
      return `❌ 经验 #${id} 不存在`;
    }

    // 将已有经验内容传给 refine，让 LLM 在此基础上加工
    const extractor = getExperienceExtractor();
    const { draft, similar } = await extractor.refine(
      `编辑经验 #${id}: ${rec.scenario} — ${rec.problem} — ${rec.solution}`,
      {
        scenario: rec.scenario,
        problem: rec.problem,
        solution: rec.solution,
        reasoning: rec.reasoning,
        tags: rec.tags,
        type: rec.type,
        outcome: rec.outcome,
      },
    );

    this._draft = { draft, editId: id, similar, rawText: `编辑 #${id}` };

    return this.formatDraft(draft, similar, true, id);
  }

  // ─── 查看流程 ──────────────────────────────────────────────────────────────

  private handleList(limitStr?: string): string {
    const limit = parseInt(limitStr || '10', 10);
    const store = getExperienceStore();
    const records = store.getAll(limit);

    if (records.length === 0) {
      return '暂无经验记录。使用 /exp add 录入第一条经验。';
    }

    const stats = store.getStats();
    const lines: string[] = [
      `经验库 (${stats.active} 活跃 / ${stats.total} 总计):`,
      '',
    ];

    for (const r of records) {
      const typeIcon = r.type === 'pattern' ? '✅' : r.type === 'pitfall' ? '⚠️' : '💡';
      const status = r.status === 'deprecated' ? ' [已废弃]' : '';
      const reuseInfo = r.reuseCount > 0 ? ` (复用${r.reuseCount}次)` : '';
      lines.push(`${typeIcon} #${r.id}${status} [${r.score.toFixed(2)}]${reuseInfo} ${r.scenario}`);
      lines.push(`   标签: [${r.tags.join(', ')}]`);
    }

    lines.push('');
    lines.push(`/exp view <id> 查看详情 | /exp search <关键词> 搜索`);

    return lines.join('\n');
  }

  private handleView(idStr?: string): string {
    const id = parseInt(idStr || '', 10);
    if (!id) {
      return '用法: /exp view <id>';
    }

    const store = getExperienceStore();
    const rec = store.getById(id);
    if (!rec) {
      return `❌ 经验 #${id} 不存在`;
    }

    return this.formatRecord(rec);
  }

  private handleSearch(keyword: string): string {
    if (!keyword.trim()) {
      return '用法: /exp search <关键词>';
    }

    const store = getExperienceStore();
    const results = store.search(keyword, 10);

    if (results.length === 0) {
      return `未找到与 "${keyword}" 相关的经验。`;
    }

    const lines: string[] = [`搜索 "${keyword}" — 找到 ${results.length} 条:`];
    for (const r of results) {
      const typeIcon = r.type === 'pattern' ? '✅' : r.type === 'pitfall' ? '⚠️' : '💡';
      lines.push(`${typeIcon} #${r.id} [${r.score.toFixed(2)}] ${r.scenario}`);
      lines.push(`   ${r.problem.slice(0, 80)}`);
    }
    lines.push('');
    lines.push('/exp view <id> 查看详情');

    return lines.join('\n');
  }

  // ─── 删除流程 ──────────────────────────────────────────────────────────────

  private handleDelete(idStr?: string): string {
    const id = parseInt(idStr || '', 10);
    if (!id) {
      return '用法: /exp delete <id>';
    }

    const store = getExperienceStore();
    const rec = store.getById(id);
    if (!rec) {
      return `❌ 经验 #${id} 不存在`;
    }

    const ok = store.delete(id);
    if (ok) {
      return `🗑️ 经验 #${id} 已删除:\n   场景: ${rec.scenario}`;
    }
    return `❌ 删除失败`;
  }

  // ─── 统计 ──────────────────────────────────────────────────────────────────

  private handleStats(): string {
    const store = getExperienceStore();
    const stats = store.getStats();

    const lines: string[] = [
      '📊 经验库统计:',
      `   总计: ${stats.total} 条`,
      `   活跃: ${stats.active} 条`,
      `   已废弃: ${stats.deprecated} 条`,
      '',
      `   按类型:`,
      `     ✅ 成功模式: ${stats.patterns}`,
      `     ⚠️ 踩坑教训: ${stats.pitfalls}`,
      `     💡 通用建议: ${stats.tips}`,
    ];

    if (stats.active > 0) {
      const top = store.getActive().slice(0, 5);
      lines.push('');
      lines.push('   Top 5 经验:');
      for (const r of top) {
        lines.push(`     #${r.id} [${r.score.toFixed(2)}] ${r.scenario} (复用${r.reuseCount}次)`);
      }
    }

    return lines.join('\n');
  }

  // ─── 帮助 ──────────────────────────────────────────────────────────────────

  private handleHelp(): string {
    return [
      '经验管理命令:',
      '  /exp add <描述>      录入新经验（Agent 加工后展示，确认才保存）',
      '  /exp confirm         确认保存当前草稿',
      '  /exp cancel          取消当前草稿',
      '  /exp list [n]        列出最近 n 条经验（默认 10）',
      '  /exp view <id>       查看单条经验详情',
      '  /exp search <关键词>  搜索经验',
      '  /exp edit <id>       编辑已有经验（复用录入流程）',
      '  /exp delete <id>     删除经验',
      '  /exp stats           经验库统计',
      '',
      '录入流程: /exp add 描述 → Agent 加工展示 → /exp confirm 确认 | /exp cancel 取消',
    ].join('\n');
  }

  // ─── 格式化 ────────────────────────────────────────────────────────────────

  private formatDraft(draft: ExtractedExperience, similar: RetrieveResult[], isEdit: boolean, editId?: number): string {
    const typeLabel = draft.type === 'pattern' ? '✅ 成功模式' : draft.type === 'pitfall' ? '⚠️ 踩坑教训' : '💡 通用建议';
    const action = isEdit ? `修改经验 #${editId}` : '新经验草稿';

    const lines: string[] = [
      `📝 ${action}（Agent 已加工泛化）:`,
      '',
      `   类型: ${typeLabel}`,
      `   场景: ${draft.scenario}`,
      `   问题: ${draft.problem}`,
      `   解法: ${draft.solution}`,
    ];

    if (draft.reasoning && draft.reasoning !== 'N/A') {
      lines.push(`   推理: ${draft.reasoning}`);
    }

    lines.push(`   标签: [${draft.tags.join(', ')}]`);

    // 相似经验提示
    if (similar.length > 0) {
      lines.push('');
      lines.push('🔍 相似经验（去重参考）:');
      for (const s of similar) {
        const pct = (s.matchScore * 100).toFixed(0);
        lines.push(`   #${s.record.id} [${pct}%相似] ${s.record.scenario}`);
      }
    }

    lines.push('');
    lines.push('✅ /exp confirm 确认保存 | ❌ /exp cancel 取消');

    return lines.join('\n');
  }

  private formatRecord(rec: ExperienceRecord): string {
    const typeLabel = rec.type === 'pattern' ? '✅ 成功模式' : rec.type === 'pitfall' ? '⚠️ 踩坑教训' : '💡 通用建议';
    const statusLabel = rec.status === 'deprecated' ? ' [已废弃]' : '';
    const sourceLabel = rec.source === 'user' ? '👤 用户录入' : rec.source === 'feedback' ? '💬 反馈' : '🤖 自动提取';

    const lines: string[] = [
      `经验 #${rec.id}${statusLabel}`,
      '',
      `   类型: ${typeLabel}`,
      `   来源: ${sourceLabel}`,
      `   场景: ${rec.scenario}`,
      `   标签: [${rec.tags.join(', ')}]`,
      '',
      `   问题: ${rec.problem}`,
      `   解法: ${rec.solution}`,
    ];

    if (rec.reasoning && rec.reasoning !== 'N/A') {
      lines.push(`   推理: ${rec.reasoning}`);
    }

    if (rec.codeSnippet) {
      lines.push(`   代码: ${rec.codeSnippet.slice(0, 200)}`);
    }

    lines.push('');
    lines.push(`   评分: ${rec.score.toFixed(2)} | 复用: ${rec.reuseCount}次 (成功${rec.successCount}/失败${rec.failCount})`);
    lines.push(`   创建: ${rec.createdAt.slice(0, 10)} | 更新: ${rec.updatedAt.slice(0, 10)}`);

    if (rec.project) lines.push(`   项目: ${rec.project}`);
    if (rec.modelUsed) lines.push(`   模型: ${rec.modelUsed}`);

    lines.push('');
    lines.push('/exp edit ' + rec.id + ' 编辑 | /exp delete ' + rec.id + ' 删除');

    return lines.join('\n');
  }
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

let _instance: ExperienceCommandHandler | null = null;

export function getExperienceCommandHandler(): ExperienceCommandHandler {
  if (!_instance) {
    _instance = new ExperienceCommandHandler();
  }
  return _instance;
}
