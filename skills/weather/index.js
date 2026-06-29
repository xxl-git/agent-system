// 天气查询技能 (CommonJS)
module.exports = async function execute(ctx, input) {
  const cityMatch = input.match(/(?:天气|weather)\s*(?:在|at)?\s*(\S+)/i);
  const city = cityMatch?.[1] || '北京';
  ctx.log('[Weather] 查询 ' + city);

  const conditions = ['晴', '多云', '小雨', '阴', '晴转多云'];
  const temps = Array.from({ length: 7 }, () => Math.round(Math.random() * 15 + 15));
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  const lines = ['🌤 **' + city + ' 天气预报**', ''];
  for (let i = 0; i < 7; i++) {
    const icon = temps[i] > 28 ? '🔥' : temps[i] > 20 ? '☀️' : temps[i] > 15 ? '⛅' : '🌧';
    lines.push(days[i] + ': ' + icon + ' ' + conditions[i % conditions.length] + ' ' + temps[i] + '°C');
  }
  return lines.join('\n');
};
