#!/usr/bin/env ts-node
import { LMStudioAdapter } from '../src/models/adapters/lmstudio';
import { SmartAdapter } from '../src/core/smart-adapter';
import { loadConfig } from '../src/config';

const SEP = '═'.repeat(50);
let okC = 0, noC = 0;
const ok = (n: string, d?: string) => { okC++; console.log('  ✓', n + (d ? ' (' + d + ')' : '')); };
const no = (n: string, e?: string) => { noC++; console.log('  ✗', n, e ? ': ' + e : ''); };

function main() {
  loadConfig();
  console.log('\n' + SEP + '\n  SmartAdapter 重复检测测试\n' + SEP + '\n');
  const raw = new LMStudioAdapter();
  const smart = new SmartAdapter(raw, { repetitionThreshold: 0.3, maxSimilarConsecutive: 3, ngramSize: 4, callTimeoutMs: 5000, maxRetries: 1 });
  const check = (smart as any).checkRepetition.bind(smart);

  // 1. Normal
  console.log('── 1. 正常文本 ──');
  check('今天天气真好，我们出去散步吧。路上看到了很多花。').isRepeat ? no('误判') : ok('通过');

  // 2. Repeater
  console.log('\n── 2. 复读机 ──');
  const r1 = check('你好你好你好你好你好你好你好你好你好你好你好你好你好你好');
  r1.isRepeat ? ok('检测', r1.reason) : no('未检测');
  if (r1.deduped && r1.deduped.length < 32) ok('去重');

  // 3. Paragraph loop
  console.log('\n── 3. 段落循环 ──');
  const r2 = check('根据分析建议采用方案A。根据分析建议采用方案A。根据分析建议采用方案A。根据分析建议采用方案A。');
  r2.isRepeat ? ok('检测', r2.reason) : no('未检测');

  // 4. Exact duplicate
  console.log('\n── 4. 跨请求完全相同 ──');
  smart.reset();
  check('这是第一次回复，包含了详细的说明和分析内容，共计约五十个字符左右');
  check('这是第一次回复，包含了详细的说明和分析内容，共计约五十个字符左右').isRepeat ? ok('检测') : no('未检测');

  // 5. High similarity
  console.log('\n── 5. 跨请求高度相似 ──');
  smart.reset();
  check('根据当前数据，今年的增长率达到了百分之八点五，这是一个非常积极的信号。');
  check('根据当前数据，今年的增长率达到了百分之八点五，这是一个非常积极的信号，建议继续。').isRepeat ? ok('检测') : no('未检测');

  // 6. Normal variation
  console.log('\n── 6. 正常变化 ──');
  smart.reset();
  check('今天要讨论的是项目进度问题。');
  check('关于预算方面，我们需要进一步确认。').isRepeat ? no('误判') : ok('通过');

  // 7. Short text skip
  console.log('\n── 7. 短文本容错 ──');
  check('你好').isRepeat ? no('误判') : ok('跳过');

  // 8. Cross-request accumulation
  console.log('\n── 8. 跨请求累积 ──');
  smart.reset();
  const tmpl = '根据AI分析，当前任务状态为进行中，建议继续推进。';
  let rc = 0;
  for (let i = 0; i < 3; i++) { if (check(tmpl).isRepeat) rc++; }
  rc >= 2 ? ok('累积', rc + '/3') : no('仅' + rc);

  // 9. Mixed language
  console.log('\n── 9. 中英混合 ──');
  smart.reset();
  check('The results show significant improvement in performance.');
  check('测试结果显示性能指标有明显提升，the performance has improved.').isRepeat ? no('误判') : ok('通过');

  console.log('\n' + SEP);
  const tot = okC + noC;
  console.log('  通过: ' + okC + '/' + tot + ' (' + Math.round(okC/tot*100) + '%)');
  console.log(SEP);
  if (noC > 0) process.exit(1);
}
main();
