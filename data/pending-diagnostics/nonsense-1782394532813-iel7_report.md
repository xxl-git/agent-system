🩺 会话异常诊断报告 (#nonsense-1782394532813-iel7)
模型: qwen3.6-35b-a3b-mtp
时间: 2026-06-25T13:35:32.814Z
触发原因: 字符多样性低 (101/359)

发现:
  • 模型输出异常: 字符多样性低 (101/359)
  • 输入长度: 2 字
  • 输出长度: 500 字
  • 输入前 200 字: 你好
  • 输出前 200 字: ❌ 经过 8 级降级尝试后仍无法完成任务：

**原始任务**: chat-stream-1782394525482

**降级链记录**:
  1. 故障: unknown — this.deps.agentEventBus.modelResponding is not a function
  2. 重试 1/2 (等待 2000ms)
  3.   执行: 退避等待
  4.   重试失败:

建议:
  • 检查 LM Studio 是否正常运行
  • 检查模型输出是否合理
  • 尝试重启 LM Studio
  • 查看完整日志排查根因

---
由 NonsenseDetector 自动生成