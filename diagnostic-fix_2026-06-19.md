# Agent System 诊断修复 — 2026-06-19 23:45

## 目标
修复本地 agent 系统模型推理不可靠问题 — 从 agent 端排查通信链路，而非归咎模型。

## 分析发现（4 个串联问题）
1. **超时计数器实例级共享** — `consecutiveTimeouts` 被所有 probe 共享，probe 1 超时累加后，probe 2-7 瞬间触发死循环降级 → 全 0% 评分
2. **reasoning_content 未写入 response** — 只用于 SmartAdapter 内部校验，下游 probe 读 `content` 永远是空字符串，全部判 fail
3. **零请求/响应日志** — 无法排查 LM Studio 实际返回了什么
4. **config 模型名不匹配** — `qwen2.5-7b-instruct` 不是 LM Studio 实际加载的模型

## 修改文件
- `src/core/smart-adapter.ts` + `dist/core/smart-adapter.js` — 3 项修复
- `config/default.json` — 模型名更新 + maxTokens 512 + 修复乱码 provider name
- `HANDOVER.md` — 更新 changelog 和修复记录
- `LESSONS_LEARNED.md` — 新增 2 条教训

## 当前状态
- 源码修改完成，dist 同步修改完成
- ⚠️ 因 exec 沙箱限制未能执行 `npm run build`，需用户批准编译或直接启动测试
- 版本：v0.6.1
