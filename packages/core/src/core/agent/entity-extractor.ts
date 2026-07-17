// entity-extractor.ts
// 从文本中提取命名实体（纯函数，无副作用，无 this 依赖）

export interface Entity {
  name: string;
  type: string;
}

/**
 * 从文本中提取命名实体（简单正则，无 LLM 依赖）
 *
 * 提取的实体类型：
 * - path: 文件路径（D:\xxx, /path, ./xxx）
 * - quoted_phrase: 引号中的短语
 * - mention: @-mentioned 标识符
 * - proper_noun: 大写英文词组（专有名词）
 * - email: 邮箱地址
 * - url: URL
 *
 * @param text 输入文本
 * @param maxEntities 最大返回实体数（默认 20）
 * @returns 去重后的实体列表
 */
export function extractEntities(text: string, maxEntities: number = 20): Entity[] {
  const seen = new Set<string>();
  const results: Entity[] = [];

  // 1. 路径实体: D:\xxx, /path, ./xxx
  const pathMatches = text.match(/[A-Za-z]:\\[\w\-.\/\\]+|[.\/][\w\-./\\]+/g) || [];
  for (const p of pathMatches) {
    const name = p.slice(0, 60);
    if (seen.has(name)) continue;
    seen.add(name);
    results.push({ name, type: 'path' });
  }

  // 2. 引号中的短语: "xxx", 'xxx'
  const quotedMatches = text.match(/["'][^\n"']{2,50}["']/g) || [];
  for (const q of quotedMatches) {
    const name = q.slice(1, -1).trim();
    if (seen.has(name) || name.length < 2) continue;
    seen.add(name);
    results.push({ name, type: 'quoted_phrase' });
  }

  // 3. @-mentioned 标识符: @something
  const atMatches = text.match(/@[a-zA-Z_][\w\-_]{1,30}/g) || [];
  for (const m of atMatches) {
    const name = m.slice(1);
    if (seen.has(name)) continue;
    seen.add(name);
    results.push({ name, type: 'mention' });
  }

  // 4. 大写英文词组 (假设为专有名词): Word Word Word
  const capMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g) || [];
  for (const w of capMatches) {
    if (seen.has(w) || w.length < 4) continue;
    seen.add(w);
    results.push({ name: w, type: 'proper_noun' });
  }

  // 5. 邮箱
  const emailMatches = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  for (const e of emailMatches) {
    if (seen.has(e)) continue;
    seen.add(e);
    results.push({ name: e, type: 'email' });
  }

  // 6. URL
  const urlMatches = text.match(/https?:\/\/[^\s"'<>]{5,100}/g) || [];
  for (const u of urlMatches) {
    if (seen.has(u)) continue;
    seen.add(u);
    results.push({ name: u.slice(0, 60), type: 'url' });
  }

  return results.slice(0, maxEntities);
}
