// entity-extractor.test.ts
// 单元测试：从文本中提取命名实体
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../entity-extractor';

test('extractEntities: 路径实体', () => {
  const entities = extractEntities('打开 D:\\Projects\\test 和 /home/user/file.txt');
  const paths = entities.filter(e => e.type === 'path');
  assert.ok(paths.length >= 2, `应至少提取到2个路径, 实际: ${paths.length}`);
  assert.ok(paths.some(p => p.name.includes('D:\\Projects\\test')), '应包含 Windows 路径');
  assert.ok(paths.some(p => p.name.includes('/home/user')), '应包含 Unix 路径');
});

test('extractEntities: 引号短语', () => {
  const entities = extractEntities('请查看 "重要文档" 和 \'另一个短语\'');
  const quoted = entities.filter(e => e.type === 'quoted_phrase');
  assert.ok(quoted.length >= 2, `应提取到2个引号短语, 实际: ${quoted.length}`);
  assert.ok(quoted.some(q => q.name === '重要文档'), '应包含中文引号短语');
});

test('extractEntities: @-mention', () => {
  const entities = extractEntities('通知 @alice 和 @bob_smith 关于项目的事');
  const mentions = entities.filter(e => e.type === 'mention');
  assert.equal(mentions.length, 2);
  assert.ok(mentions.some(m => m.name === 'alice'));
  assert.ok(mentions.some(m => m.name === 'bob_smith'));
});

test('extractEntities: 大写专有名词', () => {
  const entities = extractEntities('Apple Inc and Microsoft Corporation are tech companies');
  const proper = entities.filter(e => e.type === 'proper_noun');
  assert.ok(proper.length >= 2, `应至少提取到2个专有名词, 实际: ${proper.length}`);
  assert.ok(proper.some(p => p.name === 'Apple Inc'));
  assert.ok(proper.some(p => p.name === 'Microsoft Corporation'));
});

test('extractEntities: 邮箱', () => {
  const entities = extractEntities('发邮件到 alice@example.com 或 bob@test.org');
  const emails = entities.filter(e => e.type === 'email');
  assert.equal(emails.length, 2);
  assert.ok(emails.some(e => e.name === 'alice@example.com'));
  assert.ok(emails.some(e => e.name === 'bob@test.org'));
});

test('extractEntities: URL', () => {
  const entities = extractEntities('访问 https://example.com/path 和 http://test.org/page');
  const urls = entities.filter(e => e.type === 'url');
  assert.ok(urls.length >= 2, `应至少提取到2个URL, 实际: ${urls.length}`);
  assert.ok(urls.some(u => u.name.includes('https://example.com')));
  assert.ok(urls.some(u => u.name.includes('http://test.org')));
});

test('extractEntities: 去重', () => {
  const entities = extractEntities('"test" "test" "test" @alice @alice');
  const names = entities.map(e => e.name);
  const uniqueNames = [...new Set(names)];
  assert.equal(names.length, uniqueNames.length, '应去重');
});

test('extractEntities: 空字符串', () => {
  const entities = extractEntities('');
  assert.equal(entities.length, 0);
});

test('extractEntities: 无实体文本', () => {
  const entities = extractEntities('这是一段普通的中文文本，没有任何实体');
  assert.equal(entities.length, 0);
});

test('extractEntities: maxEntities 限制', () => {
  // 构造超过 20 个实体的文本
  const manyPaths = Array.from({ length: 30 }, (_, i) => `C:\\path${i}`).join(' ');
  const entities = extractEntities(manyPaths);
  assert.ok(entities.length <= 20, `应限制在20个以内, 实际: ${entities.length}`);
});

test('extractEntities: 混合实体', () => {
  const text = '查看 "项目计划" 在 D:\\docs\\plan.md，联系 @manager，访问 https://project.example.com';
  const entities = extractEntities(text);
  const types = new Set(entities.map(e => e.type));
  assert.ok(types.has('quoted_phrase'), '应包含引号短语');
  assert.ok(types.has('path'), '应包含路径');
  assert.ok(types.has('mention'), '应包含@mention');
  assert.ok(types.has('url'), '应包含URL');
});

test('extractEntities: 短引号被过滤', () => {
  const entities = extractEntities('"a" "ab" "abc"');
  const quoted = entities.filter(e => e.type === 'quoted_phrase');
  // "a" 长度 < 2 应被过滤，"ab" 和 "abc" 应保留
  assert.ok(quoted.length >= 2, `应保留长度>=2的引号短语, 实际: ${quoted.length}`);
  assert.ok(!quoted.some(q => q.name === 'a'), '长度<2的应被过滤');
});
