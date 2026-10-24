# AgentHub 本地房间 · Phase 1–5

这是一个本地优先、单用户的多模型群聊：每个成员绑定一个平台/模型和一张角色卡，
房间按 @提及、计划顺序或公平池自动交接，直到 `DONE`、人类 @、预算或上下文上限。

- 主战场：Electron 桌面应用（`room.html`），数据在 `%APPDATA%\agent-space-local\rooms`。
- 后端：Node 直接跑 TypeScript（`--experimental-strip-types`），不依赖 PostgreSQL。
- 真实模型：Codex CLI（DeepSeek / GLM / Kimi）已验证；Claude relay 平台保留但当前 relay 返回 404。
- 也可以接 OpenAI 兼容网关（`aiwork-api`），需要设置 `AIWORK_API_KEY`。

## 快速开始

```bash
# 假后端演示房间（不花钱、不联网）
npm run room -- init --data-dir .tmp/room-demo
npm run room -- run --data-dir .tmp/room-demo --prompt "为本地房间设计一个成员配置界面"

# 三个真实模型：架构师/实现者/前端优化（会消耗额度）
npm run room -- init --real --workspace F:\path\to\your\code
npm run room -- run --room real --prompt "审查当前登录页并给出前端优化方案"

# 平台健康、模型目录、本机技能/MCP 清单
npm run room -- platforms --health
npm run room -- models sync          # 从 AIWorkGate 本地库导入 600+ 模型
npm run room -- capabilities --json  # 只读扫描 Claude skills / Codex+Claude MCP

# 图片只发给声明支持图片的模型；其他成员只收到附件说明
npm run room -- run --room real --prompt "看这张设计图" --image .\design.png

# 可选：用本机 ModLens 把图片转成文字证据（不随应用打包）
npm run room -- vision --image .\design.png --prompt "UI 结构"
```

桌面应用：

```bash
npm run desktop:local:dir
dist-electron-local-out\win-unpacked\AgentSpaceLocal.exe
```

> 若从本仓库的开发 shell 启动，先清掉 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会以
> Node 模式运行并拒绝窗口参数。

## 已实现

- `types.ts / store.ts`：房间、角色卡、平台/模型绑定、追加式 JSONL 事件、每回合产物。
- `policy.ts`：@提及、计划顺序、公平池、禁止连续同一人、`DONE`、人类 @、次数/预算/低自治停止。
- `transcript.ts`：简报 + 最近消息 + 滚动摘要 + 图片路径；按 token 预算裁剪。
- `engine.ts`：回合循环、流式 delta、失败/中止、上下文 70% 摘要 / 85% 硬停。
- `backends/fake.ts`：确定性假后端，覆盖全部引擎测试。
- `agent-router` + `backends/cli.ts`：Codex/Claude CLI、session 续接、思考强度、图片、MCP 配置、
  失败诊断、进程树终止。
- `backends/openai.ts`：OpenAI 兼容 SSE、usage/费用、`reasoning_effort`、本地图片转 base64。
- `backends/router.ts`：健康门禁、主模型 → 备用链、显式模型切换事件、非视觉成员图片降级。
- `catalog.ts / health.ts / sessions.ts`：模型能力目录（627 个网关模型）、健康检查、房间/成员/模型级 session。
- `summary.ts`：跨阈值后用最便宜成员做滚动摘要。
- `capabilities.ts`：只读扫描 270+ Claude/skill-library 技能与 Codex/Claude MCP 名称，不读取 env/密钥。
- `vision.ts`：可选 ModLens 桥，按「图片 + 提示词」哈希缓存。
- Electron：房间列表、成员角色卡编辑、598 模型筛选、思考档、备用链、上下文预算、计划顺序、
  流式气泡、交接/摘要/换模型提示、费用/ token、停止、回放、本机技能/MCP 清单。
- 39 个单元/集成测试。

## 数据格式

```text
%APPDATA%\agent-space-local\rooms\<roomId>\
  room.json          房间配置与成员
  brief.md           人类可编辑的房间简报
  summary.md         滚动摘要
  events.jsonl       追加式事件日志
  sessions.json      成员 × 平台 × 模型的 session
  runs\<turnId>.json 每回合原始 prompt 与后端结果
```

## 还没做（v1.5）

- 工作区写入与审计（当前全员只读提示，不是强制沙箱）。
- 历史消息编辑/分叉/重生成。
- DSH 插件桥、房间级视觉代理（非视觉成员自动调用 ModLens）。
- 桌面端图片选择器（当前发图走 CLI `--image`）。
- 多人协作、并行 fan-out、技能市场。

## 许可

本项目包含 HKUDS AgentSpace 的代码，按 Apache License 2.0 分发；
详见 `LICENSE` 与 `NOTICE`。
