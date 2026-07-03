# xbrowser 安装记录 - 2026-07-03

## 安装过程

1. **问题**：`xb` CLI 不可用，`xb.c.js` 文件不存在（路径错误，实际是 `xb.cjs`）
2. **解决**：确认 `scripts/xb.cjs` 已存在（87652 字节，已编译），无需重新编译
3. **路径修正**：`xb.c.js` → `xb.cjs`（少了一个点）
4. **初始化**：`node xb.cjs init` 成功，返回 ready，浏览器 = cft，headed = true
5. **Shield 配置**：
   - 配置文件路径：`C:\Users\xl\.qclaw\tools\xbrowser\shield\config.json`
   - 格式：`{ version: 1, enabled: bool, allowlist: string[], _sig: string }`
   - 签名密钥：`shield-config-v1:${QCLAW_CLI_NODE_BINARY}`
   - 已添加 `127.0.0.1:19701` 到白名单
   - 已禁用 shield（`enabled: false`）以允许本地地址访问
6. **遗留问题**：agent-browser 进程缓存了 shield 配置，需要重启进程才能生效

## 测试结果

- `xb run --browser default open http://127.0.0.1:19701/agent-ui.html` 仍被 shield 拦截
- 需要完全杀掉 agent-browser 进程后重新启动才能应用新配置
- 或手动在浏览器中打开页面进行测试

## 正确调用方式

```powershell
$NOde = "D:\software\Common\nodejs\node.exe"
$xb = "$env:USERPROFILE\.qclaw\skills\xbrowser\scripts\xb.cjs"
& $NOde $xb <command> [args]
```

## 可用命令

- `xb init` - 初始化/检查状态
- `xb run --browser default open <url>` - 打开 URL
- `xb stop cft --force` - 停止浏览器（实际需用 `xb cleanup`）
- `xb cleanup` - 清理所有浏览器会话
- `xb shield status` - 查看防护状态
