# 修复管理面板聊天标签页空白

## 问题
管理面板 `/admin` 的聊天选项卡加载 `/chat` iframe，但服务器缺少此路由，返回 404 导致界面空白。

## 修复
修改 `src/server/agent-server.ts` 第 291 行路由映射：
```
/ → agent-ui.html
/admin, /admin/ → admin-panel.html
/chat → agent-ui.html    ← 新增
/audit → audit-dashboard.html  ← 新增
```

## 验证
- `npm run build` 编译通过
- 服务器已重启（PID 36624）
- `curl http://127.0.0.1:19701/chat` → 200 / 64KB
- `curl http://127.0.0.1:19701/admin` → 200 / 57KB
