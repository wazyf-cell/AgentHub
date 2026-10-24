# AgentHub 本地房间 · Phase 1

Phase 1 完成的是**房间引擎骨架**：不接真实模型，不碰 PostgreSQL，用一个假后端验证
「多成员 → 自动交接 → 停止条件 → 可回放日志」这条主链路。

## 现在能做什么

```bash
# 初始化演示房间（默认写到 %APPDATA%\AgentSpace\rooms）
npm run room -- init

# 运行一次三人群聊（假后端）
npm run room -- run --prompt "为 AgentHub 的本地房间设计一个成员配置界面"

# 查看房间列表 / 回放 / 导出
npm run room -- list
npm run room -- replay
npm run room -- export --out D:\exports\demo-room
```

临时数据目录（测试用）：

```bash
npm run room -- init --data-dir .tmp/room-demo
npm run room -- run --data-dir .tmp/room-demo --prompt "继续"
```

演示房间包含规划者、实现者、审查者三个成员。假后端会按
`规划者 -> 实现者 -> 审查者` 的顺序自动交接，审查者以 `DONE` 结束。

## Phase 1 已实现

- `packages/daemon/src/room/types.ts`：房间、角色卡、平台、模型、事件类型。
- `store.ts`：`rooms/<id>/` 下的 `room.json`、`events.jsonl`、`runs/`、`brief.md`、`summary.md`。
- `policy.ts`：@提及优先、计划顺序、公平池、禁止连续同一人、`DONE`、人类 @、
  次数/预算/低自治停止。
- `transcript.ts`：房间简报 + 最近消息 + 摘要 + 产物引用；按 token 预算裁剪旧消息。
- `engine.ts`：回合循环、交接事件、流式 delta、失败/中止记录、每回合产物。
- `backends/fake.ts`：确定性假后端，用于引擎测试。
- `rooms-cli.ts`：`init / run / list / replay / export`。
- 28 个单元/集成测试，覆盖策略、存储、引擎、上下文组装。

## 数据格式

每个房间一个目录，事件只追加、不修改：

```text
%APPDATA%\AgentSpace\rooms\<roomId>\
  room.json         房间配置与成员
  brief.md          人类可编辑的房间简报
  summary.md        滚动摘要（Phase 3）
  events.jsonl      追加式事件日志
  runs\<turnId>.json 每回合原始 prompt 与后端结果
```

## 还没做（按路线图）

- Phase 2：真实 CLI 后端（codex / claude）、平台注册表、模型目录、session 续接。
- Phase 3：滚动摘要、真实 token/费用、健康检查与备用模型链。
- Phase 4：Electron 房间页（角色卡编辑、模型选择、流式、停止、回放）。
- Phase 5：OpenAI 兼容 API、ModLens 视觉桥、skill/MCP 只读清单、打包。
- v1.5：worktree 写入与审计、历史消息编辑/分叉、DSH 插件桥、真正发图。

## 非目标（v1）

团队平台 / PostgreSQL、并行 fan-out、默认放开文件写入、技能市场、多人协作。

## 许可

本项目包含 HKUDS AgentSpace 的代码，按 Apache License 2.0 分发；
详见 `LICENSE` 与 `NOTICE`。
