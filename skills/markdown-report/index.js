// Markdown 报告技能 (CommonJS)
const fs = require('fs');
const path = require('path');

module.exports = async function execute(ctx, input) {
  const titleMatch = input.match(/(?:报告|report|生成报告)\s*(.+)/i);
  const title = titleMatch?.[1]?.trim() || '自动生成报告';
  ctx.log('[Report] ' + title);

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const id = 'RPT-' + Date.now().toString(36).toUpperCase();

  const report = '# ' + title + '\n\n' +
    '> **报告编号**: ' + id + '\n' +
    '> **生成时间**: ' + now + '\n\n' +
    '## 概述\n本报告由 Agent System 自动生成。\n\n' +
    '## 摘要\n自动生成模板。可扩展为项目周报、测试报告等。\n\n' +
    '*由 Agent System v0.5 生成*';

  const reportDir = path.join(ctx.dataDir, 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const filePath = path.join(reportDir, id + '.md');
  fs.writeFileSync(filePath, report, 'utf-8');

  return '✅ 报告已生成\n📄 **' + title + '**\n📁 `' + filePath + '`';
};
