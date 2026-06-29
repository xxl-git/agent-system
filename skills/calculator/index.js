// 计算器技能 (CommonJS)
module.exports = async function execute(ctx, input) {
  const expr = input.replace(/^(?:计算|calculate|算|math)\s*/i, '').trim();
  if (!expr) return '请提供要计算的表达式，例如: "计算 2 + 3 * 4"';
  ctx.log('[Calc] ' + expr);
  try {
    const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, '');
    if (!sanitized || sanitized.length > 200) return '表达式无效或太长';
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return '🧮 ' + expr + ' = **' + result + '**';
  } catch (e) {
    return '❌ 计算失败: ' + e.message;
  }
};
