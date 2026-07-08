# 超时设置修复 - 2026-06-25

## 问题

用户反馈："经过几秒模型不响应，你就直接结束对话"。本地模型（LM Studio）响应非常慢，需要至少 60 秒的超时时间，但前端/后端的超时设置可能不正确或被重置。

## 根本原因

1. **前端 `fetch()` 没有超时控制**：前端调用 `/api/chat/stream` 时，没有设置超时，完全依赖浏览器的默认行为或后端的超时设置。
2. **后端超时设置可能不正确**：配置文件中的 `callTimeoutMs` 和 `chatTimeoutMs` 可能被重置或设置太短。
3. **缺少最小值限制**：没有强制最小超时为 60 秒的限制。

## 修复内容

### 1. 前端添加超时控制 (`agent-ui.html`)

#### 修改 `send()` 函数
- 添加前端超时计时器，默认 120 秒，最小 60 秒
- 超时后主动断开连接并提示用户
- 超时设置从 `localStorage` 读取，用户可在设置面板中配置

```javascript
// 获取用户设置的超时时间（默认 120 秒，最小 60 秒）
const userTimeout = Math.max(60000, parseInt(localStorage.getItem('chatTimeoutMs') || '120000'));
const timeoutId = setTimeout(() => {
  if (genAbort) {
    genAbort.abort();
    showToast(`⚠️ 模型响应超时（${userTimeout/1000}秒），请尝试增加超时时间或使用更快的模型`);
  }
}, userTimeout);
```

#### 修改 `saveSettings()` 函数
- 强制最小超时 60 秒
- 保存超时设置到本地存储
- 显示保存的超时值

```javascript
// 强制最小超时 60 秒
const callTimeoutMs = Math.max(60000, parseInt(document.getElementById('cfgTimeout').value) || 60000);
const chatTimeoutMs = Math.max(60000, parseInt(document.getElementById('cfgChatTimeout').value) || 120000);

// 保存聊天超时到本地存储（前端使用）
localStorage.setItem('chatTimeoutMs', chatTimeoutMs.toString());
```

#### 修改 `fetchConfig()` 函数
- 加载配置时强制最小超时 60 秒
- 同步到本地存储

#### 更新设置面板 HTML
- 添加详细的超时设置说明
- 设置最小值为 60 秒
- 提示用户本地模型通常较慢，建议设置更长的超时

```html
<div class="sd-field">
  <label>模型请求超时 (毫秒)</label>
  <input id="cfgTimeout" type="number" value="60000" min="60000" max="300000" step="5000">
  <div class="hint">⏱ 等待模型响应的最大时间。<br>⚠ 本地模型通常较慢，建议设置 60000 (60秒) 以上。<br>📍 最小值: 60000ms (60秒)</div>
</div>
<div class="sd-field">
  <label>聊天流式超时 (毫秒)</label>
  <input id="cfgChatTimeout" type="number" value="120000" min="60000" max="600000" step="10000">
  <div class="hint">⏱ 流式聊天的超时时间，控制前端等待模型响应的最长时间。<br>⚠ 本地模型推理可能需要 60-120 秒，建议设置 120000 (120秒)。<br>📍 最小值: 60000ms (60秒) | 当前设置会同步保存到本地存储</div>
</div>
```

### 2. 后端强制最小超时 60 秒 (`agent-server.ts`)

#### 修改 POST `/api/config` 端点
- 强制最小超时 60 秒
- 更新配置时验证最小值

```typescript
// 强制最小超时 60 秒
if (callTimeoutMs) currentConfig.agent.callTimeoutMs = Math.max(60000, Number(callTimeoutMs));
if (chatTimeoutMs) {
  const safeChatTimeoutMs = Math.max(60000, Number(chatTimeoutMs));
  // 写入 YAML 配置
}
```

#### 修改 GET `/api/config` 端点
- 返回配置时强制最小超时 60 秒

```typescript
// 强制最小超时 60 秒
const callTimeoutMs = Math.max(60000, cfg.agent?.callTimeoutMs || 60000);
const chatTimeoutMs = Math.max(60000, cfg.server?.chatTimeoutMs || 120000);
```

## 配置文件当前值

### config/default.json
- `callTimeoutMs`: 300000 (300秒)
- `timeoutMs`: 120000 (120秒)

### config/agent-system.yaml
- `callTimeoutMs`: 120000 (120秒)
- `chatTimeoutMs`: 120000 (120秒)

## 用户体验改进

1. **前端超时提示**：超时后显示友好的提示信息，告知用户当前超时设置和建议
2. **设置面板说明**：每个超时设置都有详细的说明，帮助用户理解其作用
3. **最小值保护**：强制最小超时 60 秒，防止用户设置过短的超时时间
4. **本地存储**：前端超时设置保存到本地存储，避免每次都从后端读取

## 测试建议

1. 启动服务器，打开 `http://127.0.0.1:19701`
2. 点击设置按钮，查看超时设置是否正确显示
3. 修改超时设置，保存后刷新页面，检查是否保存成功
4. 发送一条消息，等待模型响应（可能需要 60-120 秒）
5. 验证前端不会在几秒后就断开连接

## 相关文件

- `agent-ui.html` - 前端 UI 和 JavaScript
- `src/server/agent-server.ts` - 后端 API 服务器
- `config/default.json` - JSON 配置文件
- `config/agent-system.yaml` - YAML 配置文件
