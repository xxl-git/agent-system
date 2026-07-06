---
version: "1.1.0"
taskType: summarize
wrapper: minimal
params:
  temperature: 0
  max_tokens: 1024
  reasoning: off
---
请压缩以下对话历史为精炼摘要（中文，200字以内），并提取关键信息。

对话历史：
{{conversationHistory}}

输出格式（不要加多余内容）：
摘要：<精炼摘要>
主题：<主题1>, <主题2>
决策：<决策1> | <决策2>
实体：<实体1>, <实体2>
