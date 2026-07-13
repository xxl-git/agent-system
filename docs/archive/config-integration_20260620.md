# Agent System 配置整合 (2026-06-20)

## 完成的工作

### 1. NonsenseDetector 配置化 (`src/resilience/nonsense-detector.ts`)
- 全部硬编码常量替换为通过 `getNonsenseConfig()` 动态读取
- 新增 `restartMonitor()` 方法，热重载配置后重启监控
- 胡话检测算法所有阈值、自定义规则、崩溃模式均从配置读取
- 保留 `detectGibberish()` 作为静态方法但内部读取配置（每次调用时读，热重载即时生效）

### 2. AgentSystemConfig 接口扩展 (`src/config/agent-system-config.ts`)
- 新增 `agent` 字段：`callTimeoutMs`, `maxRetries`, `emptyLoopThreshold`
- 新增 `context` 字段：`maxTokens`, `hotWindowSize`, `attentionEnabled`
- 修正之前遗留的接口定义重复问题（nonsense 块重复 + diagnostics `{{` 语法错误）
- 添加 barrel export `src/config/index.ts`

### 3. /config 命令 (`src/core/agent/agent-core.ts`)
- `case 'config'` 支持三个子命令：
  - `/config show` — 查看当前完整配置
  - `/config reload` — 热重载 YAML 文件 + 重启 NonsenseDetector 监控
  - `/config path` — 显示配置文件路径
- `/help` 列表中加入 `/config`
- `init()` 首行调用 `initConfig()` 确保初始化时加载配置
- 热重载后自动调用 `nonsenseDetector.restartMonitor()` 使新阈值/规则即时生效

### 4. YAML 配置文件更新 (`config/agent-system.yaml`)
- 新增 `agent` 和 `context` 配置段落（含注释）
- 用户可直接编辑文件 + `/config reload` 生效

### 5. formatConfig() 更新 (`src/config/agent-system-config.ts`)
- `agent` 和 `context` 区块纳入格式输出

## 架构说明

```
用户编辑 config/agent-system.yaml
        ↓
  initConfig() / reloadConfig()
        ↓
  js-yaml 解析 → 与 DEFAULT_CONFIG 深度合并 → currentConfig
        ↓↓
  getConfig()      getNonsenseConfig()    formatConfig()
  → SmartAdapter    → NonsenseDetector    → /config show
  → ContextManager   阈值/规则/监控
```

## 文件清单
| 文件 | 操作 |
|------|------|
| `src/config/agent-system-config.ts` | 接口扩展 + 重复修复 + formatConfig 更新 |
| `src/config/index.ts` | 新建 barrel export |
| `src/resilience/nonsense-detector.ts` | 重构：硬编码 → 配置驱动 |
| `src/core/agent/agent-core.ts` | 添加 /config 命令 + initConfig 调用 |
| `config/agent-system.yaml` | 新增 agent + context 配置段落 |
