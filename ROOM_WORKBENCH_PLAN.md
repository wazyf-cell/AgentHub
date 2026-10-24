# AgentHub 本地房间 Workbench 实施计划

> 状态：2026-10-24。Slice 0–9 已全部实现并验证；后续按实际使用反馈迭代。
> 分支：`feature/local-room`；已同步到 `main`。
> 目的：把已确认的多轮设计固化成可执行计划，避免后续会话丢失上下文。

## 1. 目标与非目标

### 目标

- 本地优先、单用户的多人格房间：每个成员绑定一个平台/模型和一张角色卡，成员按 `@提及 → 计划顺序 → 公平池` 自动交接。
- 在房间之上增加 Workbench：任务板、每任务独立 git worktree、只读文件/Git/查找面板、可选的 codegraph 图谱和 btw 侧问。
- 人始终是最终合并者；默认不自动合并、不并行爆炸、不越过房间工作区写文件。

### 非目标（本轮明确不做）

- 不恢复团队/PostgreSQL/Next.js/权限体系；不引入账号、租户、云端同步。
- 不做完整 IDE、终端、代码编辑器、插件市场。
- 不做跨房间共享任务、自动 DAG 规划、超过 2 个并发任务。
- 不为尚未实现的功能放“即将推出”占位。

## 2. 当前事实（写计划时的代码状态）

### 已实现

- 房间引擎：`packages/daemon/src/room/`（types / store / policy / transcript / engine / summary / sessions / health / backends）。
- 真实后端：Codex CLI 可用；Claude relay 仍 404；OpenAI-compatible 需 `AIWORK_API_KEY`。
- Electron 五区壳层（提交 `1097902`）：顶栏、左侧房间/成员、对话区、状态栏；成员抽屉、房间规则浮层、应用设置、`Ctrl K` 命令面板、`Ctrl B` 折叠。
- 39 个房间测试通过；数据在 `%APPDATA%\agent-space-local\rooms`（打包版）。

### 现有创建的局限（后续切片要修）

- `room init` 只支持 `--real` / demo，且真实房间 id 固定为 `real`；再次“新建房间”只会返回已存在的 `real`。
- 成员只能编辑，不能在 UI 新增；平台只能读 `platforms.json`，不能在 UI 新增。
- `RoomConfig.workspace` 只是一个路径字符串，没有工作区实体、名称、列表或复用关系。
- 任务、worktree、右栏检查器、codegraph、btw 均未实现。

### 可直接复用的外部工具

- `git` 2.54；`ripgrep` 15；Everything `es.exe`（可选文件名加速）；codegraph CLI（`query/status/impact --json`，索引约 82 MB，可能过期）。
- 工具全部外部检测、可降级，不打包进安装包。

## 3. 已确认决策（第 1–4 轮 grilling）

### 3.1 信息架构与界面

- 房间是入口；中央在 `对话 / 任务板` 之间切换。
- 五区壳层已落地：48px 顶栏、264px 左栏、中央、26px 状态栏；右侧检查器只在需要时出现，不做常驻第三栏。
- 成员编辑放右侧抽屉；房间规则放浮层；应用设置只有一个入口。
- 任务板五列：`backlog / ready / running / review / done`；`merge_ready` 归入 review 列的待合并区；`failed / blocked / cancelled / conflict / budget_paused` 以状态徽标显示。
- 任务详情复用中央区域（看板 → 线程），不另开窗口；消息与任务通过 `sourceMessageId` 双向跳转。
- btw 用浮层，不打断主对话。

### 3.2 任务模型

- 任务属于房间，事件写入房间 journal：`task_created / task_updated / task_status / task_report`；另存 `tasks.json` 快照，任务线程写 `tasks/<task-id>/events.jsonl` 子 journal。
- 必填：标题、描述、owner、验收标准、依赖；可选：验证命令、允许路径、预算、自动合并。
- 状态：`backlog → ready → running → review → merge_ready → done`，外加 `failed / blocked / cancelled / conflict / budget_paused`。
- 只有 `backlog / ready` 可拖动；运行中的 owner、验收标准、依赖锁定。

### 3.3 Worktree 与写入边界

- 每个任务一个 worktree：`<repo>-agenthub-worktrees/<task-id>`，分支 `agenthub/<task-id>`，基线为房间工作区 HEAD。
- 创建任务前主工作区必须干净；worktree 保留到合并或丢弃；分支永不自动删除。
- 主房间 chat 只读；任务 worker 只能在 worktree 内写；主工作区永不被 agent 写。
- 房间级开关“允许任务写入”默认开；这是强制边界，不是提示词约定。

### 3.4 完成、验证与合并

- 流程：agent 提交 → runner 执行验证命令（exit 0，10 分钟超时）→ reviewer agent 审查 diff → `merge_ready` → 人合并。
- 自动合并是每任务显式 opt-in，且要求：验证通过、审查通过、目标干净、`--ff-only`；房间级有总开关。
- 报告 = runner 生成（commit / 文件 / diffstat / 验证 / 成本）+ agent 生成（总结 / 风险 / 下一步），写入 `report.json`。
- 冲突：任务 worktree 内 rebase，再在主工作区 `--ff-only`；冲突则状态 `conflict`，保留 worktree，交给 owner 处理。

### 3.5 并发、预算与恢复

- 每房间并发上限：2 个任务 + 1 个 chat 回合；共享房间预算。
- 任务默认预算 ¥2；超出进入 `budget_paused`，不算失败。
- 任务线程上下文：房间 brief + 任务 + 依赖任务报告 + codegraph impact；不继承完整聊天，消息可 pin 进任务。
- 崩溃恢复：启动时 `running → interrupted`，保留 worktree，提供继续/重试/丢弃；不自动恢复。
- 重试复用任务 id，attempt +1；取消杀进程树但保留 worktree。

### 3.6 右栏检查器

- 只读：文件树、文本/Markdown/图片/diff 预览、git status/diff、查找。
- 编码 UTF-8 / GBK / UTF-16；大文件分页（2 MB）；realpath 限制在房间工作区内。
- 查找优先 ripgrep（名称 + 内容，≤200 条）；Everything 仅作可选文件名加速。
- codegraph 可选：`query/status/impact --json` 同时服务 agent 上下文与 Graph 标签页；派发前同步，60 秒超时，过期显示徽标；检测不到就降级。

### 3.7 btw

- 只读侧问、无工具、继承当前上下文；写 `btw.jsonl`；每房间最多 20 条、并发 2。
- 默认模型 = 所选消息的成员；成本单列；可提升为普通用户消息。

## 4. 新增决策（2026-10-24 本轮 Q1–Q5，已确认）

- [x] 工作区是独立实体：全局注册表（id + 自定义名称 + 绝对路径），房间通过 `workspaceId` 引用；一个工作区可被多个房间共用；重命名只改显示名，不移动目录。
- [x] 无工作区的房间 = 纯聊天房间：可正常多模型对话，任务板与 worktree 禁用并说明原因。
- [x] 左栏路径改为两个按钮：`查看` 在鼠标附近弹出完整路径长条（可复制，点路径打开资源管理器，贴边自动翻转）；`打开文件夹` 单击直接打开。整张工作区卡片只负责选中/定位，不再触发打开；房间规则浮层保留“打开”。
- [x] 新建能力顺序：下一片先做工作区 → 通用房间 → 新增成员；平台新增/编辑放到 Slice 9，之前允许手工编辑 `platforms.json`。
- [x] 新建房间的成员来源：默认复制当前房间的角色卡（含绑定、备用链、行为、权限、技能/MCP、计划顺序），另提供“默认单个成员”选项；不允许零成员房间。

### 4.1 第二轮决策（2026-10-24，已确认）

- [x] 左栏用工作区切换器：顶部卡片点开下拉，选中后过滤房间；提供“全部房间 / 纯聊天”；首次默认“全部”，之后记住上次选择。
- [x] 工作区约束：规范化绝对路径唯一（大小写不敏感）；名称唯一；id 不变；路径创建后不可改；注销只移除登记且被房间引用时拒绝；文件夹缺失标为“不可用”，允许聊天但禁用任务。
- [x] 新建房间：id 由名称自动生成（ASCII slug，冲突加后缀，界面只读）；名称允许重复；成员默认复制当前房间（可换源），同时复制 autonomy / maxHandoffs / stopToken / 预算 / 摘要阈值，并重映射 planOrder；新房间 journal、任务、brief 为空。
- [x] 成员管理：新增使用自动 id、默认角色/绑定、权重 1、只读，创建后打开抽屉；删除需确认、至少保留一人、从 planOrder 移除；跨房间复制留到“成员库”。
- [x] 非 git 工作区：必须是 git 仓库根目录才启用任务板；仓库子目录也拒绝，并提示选择根目录；聊天不受影响。

### 4.2 第三轮决策（2026-10-24，已确认）

- [x] 非 git 写入采用“沙箱草稿”：每回合独立草稿目录，agent 只在那里写；产出以卡片展示，确认后应用回工作区；不需要 git。直接写原目录暂不提供。
- [x] 新建工作区在同一浮层提供“同时创建房间”，默认勾选；取消则只登记工作区。
- [x] 任务入口：任务板“新建任务”为主，消息菜单“从消息建任务”为辅；纯聊天与非 git 工作区禁用并说明原因。

### 4.3 第四轮决策（2026-10-24，已确认）

- [x] 草稿范围：运行前可选“工作范围”（文件夹或文件），runner 只把这些原文件复制进草稿；agent 可改副本、也可新建文件；不选范围时只允许新建文件。应用只回写该范围。
- [x] 草稿位置与清理：`%APPDATA%\agent-space-local\drafts\<workspaceId>\<runId>\`；应用或丢弃后立即删除；失败草稿保留 7 天；提供“打开草稿目录”。
- [x] 应用策略：整批应用 + 逐文件勾选；新增/修改默认勾选、删除默认不勾；应用前按 hash 检测目标文件是否在草稿期间被改动，冲突默认跳过并提示；应用前把目标旧版本备份到草稿目录，失败可回退。
- [x] 默认开关：绑定工作区的房间默认允许草稿，纯聊天永久只读；房间规则可切“只读 / 允许草稿”；首次运行显示说明。
- [x] 草稿只作为聊天产物卡片，写入房间 journal；工作区是 git 时可“提升为任务”，不直接进入任务板。

## 5. 数据模型

### 5.1 工作区注册表（已确认）

```text
%APPDATA%\agent-space-local\rooms\
  workspaces.json          # { version: 1, workspaces: WorkspaceConfig[] }
  <roomId>\
    room.json
    events.jsonl
    tasks.json
    tasks\<taskId>\events.jsonl
```

```ts
interface WorkspaceConfig {
  id: string;            // slug，稳定，不可改名
  name: string;          // 用户可改名
  path: string;          // 绝对路径
  createdAt: string;
  updatedAt: string;
}
```

- `RoomConfig.workspace` 保留为解析后的绝对路径（兼容现有数据）；新增可选 `workspaceId` 指向注册表。
- 旧房间没有 `workspaceId` 时按路径匹配注册表；匹配不到则自动登记一条，名字取房间名。
- 无 `workspaceId` 且路径为空的房间 = 纯聊天房间，任务板禁用。

### 5.2 任务快照（下一阶段）

```ts
interface RoomTask {
  id: string;
  title: string;
  description: string;
  ownerMemberId: string;
  acceptance: string;
  dependsOn: string[];
  status: TaskStatus;
  sourceMessageId?: string;
  verificationCommand?: string;
  allowedPaths?: string[];
  budgetYuan?: number;
  autoMerge?: boolean;
  attempt: number;
  worktreePath?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 5.3 写入层级（已确认，细节第四轮）

房间不是只有“聊天 / 任务”两档，写入能力拆成三层：

| 层级 | 是否需要 git | agent 写到哪里 | 适合 | 风险 |
| --- | --- | --- | --- | --- |
| 纯聊天 | 否 | 不写文件 | 讨论、问答、审查 | 无 |
| 沙箱草稿（推荐中间层） | 否 | 每回合独立草稿目录，如 `<workspace>/.agenthub/scratch/<turn-id>/`；agent 只在该目录有写权限 | 简单脚本、文档、单文件草稿 | 需要“应用到工作区”一步 |
| 任务模式 | 是（仓库根目录） | 每任务 worktree | 多文件修改、需要验证/审查/回滚 | 需要 git 与干净基线 |

- 草稿内容：可选工作范围（文件/文件夹）复制进草稿；不选范围时只允许新建文件。草稿在 `%APPDATA%\agent-space-local\drafts\<workspaceId>\<runId>\`，应用/丢弃后删除，失败保留 7 天。
- 应用：整批 + 逐文件勾选；新增/修改默认勾选，删除默认不勾；hash 冲突跳过并提示；应用前备份目标旧版本，失败可回退。
- 默认开关：绑定工作区的房间默认“允许草稿”，纯聊天永久只读；房间规则可切“只读 / 允许草稿”；首次运行解释草稿不会自动落地。
- 草稿是聊天产物，不是任务；git 工作区可“提升为任务”，之后才进任务板。
- 直接写原目录暂不提供（没有 git 就没有可靠 diff/回滚）；如果以后提供，必须是默认关闭的高级危险模式。
- 边界说明：Windows 上 Codex 的 sandbox 不一定强制生效，草稿目录是“工作目录约定 + 后台校验”，不是安全沙箱；真正的硬边界是 worktree 任务模式。实现前必须实测本机 Codex 行为。

## 6. 实施切片

### Slice 0 — UI 壳层（已完成，`1097902`）

- [x] 五区布局、成员抽屉、房间规则浮层、应用设置、命令面板、快捷键。
- [x] 只重排既有功能；无任务板、无右栏代码面板、无占位。
- [x] 打包验证：房间切换、成员保存、规则保存、运行/停止、回放、能力刷新。

### Slice 1 — 创建工作区 / 房间 / 成员（已完成）

目标：让“新建”变成真的；路径展示符合用户习惯。

- [x] `workspaces.ts`：注册表读写、id 生成、路径校验（绝对路径、存在、规范化后去重）、名称去重、缺失目录标记。
- [x] CLI：`room workspace list|add|rename|remove`；`room create --name <name> --workspace <path>|--no-workspace [--copy-from <id>]`（`init` 仍保留给既有房间）。
- [x] IPC：`room:workspaces`、`room:workspace-add`、`room:workspace-rename`、`room:workspace-remove`、`room:create`。成员新增/删除走客户端改动后 `room:update` 整房保存，未单开 IPC。
- [x] UI 左栏：工作区卡片显示名称 + 两个按钮：
  - `查看`：鼠标附近小浮层显示完整路径，点路径调用 `shell.openPath`；提供“复制路径”；贴边自动翻转；键盘触发时锚定按钮。
  - `打开文件夹`：直接打开资源管理器；目录缺失时禁用并提示。
  - 卡片本身只负责选中/定位；房间规则浮层保留“打开”。
- [x] 工作区切换器：卡片点开下拉，含“全部房间 / 纯聊天 / 各工作区”；选择过滤房间列表；默认“全部”，记住上次选择。
- [x] 注销工作区：仅移除登记；被房间引用时拒绝；目录缺失只标“不可用”，不删除磁盘内容。
- [x] “新建工作区”浮层：名称 + 选择文件夹；默认勾选“同时新建房间”。
- [x] “新建房间”浮层：名称、自动 id、工作区（可选，空 = 纯聊天）、成员来源：
  - 默认复制当前房间的角色卡、绑定、备用链、行为、权限、技能/MCP 与计划顺序。
  - 可切换为“默认单个成员”。
- [x] 纯聊天房间：隐藏/禁用任务板并说明“该房间未绑定工作区”。
- [x] 成员抽屉底部“新增成员”：生成 id、默认绑定、保存后进入编辑；底部可删除成员。
- [x] 平台管理仍留到 Slice 9（先允许手工编辑 `platforms.json`，应用设置只显示路径和健康状态）。
- [x] 验收：重启后工作区/房间/成员仍在；纯聊天房间可运行但任务板禁用；不改动既有 `real`/`demo` 房间。
- 验证：46 项 `test:room` 通过、daemon typecheck 通过、打包应用 CDP 验证（创建/克隆/过滤/重命名/注销拒绝/缺失目录/1200×700 与 900×700 无横向溢出）。

### Slice 1.5 — 沙箱草稿（非 git 写入）（已完成）

目标：不需要 git 也能让聊天创建/修改文件，但不碰原目录。

- [x] `drafts.ts`：`%APPDATA%\agent-space-local\drafts\<workspaceId>\<runId>\`；按选择范围复制原文件，记录基线 hash；应用/丢弃后删除；失败草稿保留 7 天。
- [x] 后端：草稿回合以草稿目录为 cwd，平台切到可写模式；普通聊天仍只读。
- [x] 运行前“工作范围”选择（文件/文件夹，可留空 = 只新建）；记住上次范围。
- [x] 应用前按 hash 检查原文件是否已变化；冲突跳过并提示；应用前备份目标旧版本。
- [x] UI：房间规则“只读 / 允许草稿”开关（工作区房间默认草稿，纯聊天只读）；首次运行解释；运行中“草稿”徽标。
- [x] 产物卡片：新增/修改/删除列表，整批应用 + 逐文件勾选（删除默认不勾）；丢弃；打开草稿目录；git 工作区可“提升为任务”。
- [x] 测试：应用新增/修改、冲突跳过、删除默认不勾、丢弃不落地、原目录 hash 不变（未应用时）。
- [x] 验收：非 git 工作区可生成文件草稿并应用；取消应用后原目录零变化；任务板仍不可用。

### Slice 2 — 任务数据层（已完成）

- [x] `tasks.ts` + 类型：任务事件、状态机、`tasks.json`、子 journal。
- [x] 依赖校验：环检测、依赖未完成时不能进 `ready`。
- [x] CLI：`task create|list|show|update|move|report`。
- [x] 测试：状态迁移、依赖、事件重放、旧房间无任务兼容。

### Slice 3 — Worktree 管理器（已完成）

- [x] `worktrees.ts`：创建/复用/丢弃；分支命名；主工作区干净检查；非 git 工作区拒绝。
- [x] 路径 fence：所有任务读写限制在 worktree 内。
- [x] 测试：创建失败回滚、脏工作区拒绝、分支不自动删除。

### Slice 4 — 任务执行器（已完成）

- [x] `task-runner.ts`：子 journal 跑 agent 回合；注入 brief/任务/依赖报告/codegraph。
- [x] 验证命令执行、超时、退出码、报告采集。
- [x] reviewer 回合与 `merge_ready`。
- [x] 并发 2 + chat 1；预算暂停；取消杀进程树。
- [x] 测试：成功、验证失败、冲突、预算暂停、取消、崩溃恢复。

### Slice 5 — 任务板与详情（已完成）

- [x] 中央 `对话 / 任务板` 切换；五列 + 非列状态徽标。
- [x] 拖拽仅 backlog/ready；创建/编辑任务表单；owner/deps/验收/验证命令/预算。
- [x] 任务详情线程、报告、diff 摘要、合并/丢弃按钮。
- [x] 消息 ↔ 任务跳转；pin 消息进任务。
- [x] 验收：从消息建任务 → 运行 → review → merge_ready → 人工合并全链路。

### Slice 6 — 只读检查器（文件 / Git / 查找）（已完成）

- [x] 文件树、预览、编码检测、大文件分页、realpath fence。
- [x] git status / diff；查找（ripgrep，可选 Everything）。
- [x] 只在任务详情或房间打开；不常驻第三栏。
- [x] 验收：越界路径拒绝；二进制/大文件不崩；GBK 文件可读。

### Slice 7 — codegraph 图谱（已完成）

- [x] 检测 CLI、索引状态、同步按钮、过期徽标。
- [x] Graph 标签页：查询/影响列表；派发任务前自动同步（60 秒超时）。
- [x] 不可用时降级，不阻塞任务。

### Slice 8 — btw 侧问（已完成）

- [x] 浮层、只读提示、模型选择、并发/条数限制、成本单列、提升为消息。
- [x] `btw.jsonl` 重放。

### Slice 9 — 平台管理与打包（已完成）

- [x] 平台新增/编辑：`cli`（harness、超时、权限）与 `openai-compatible`（baseUrl、apiKeyEnv、超时）。
- [x] 健康检查与凭据不落明文；保存前验证。
- [x] 外部工具检测（git / rg / codegraph / es）与缺失提示。
- [x] 打包：只带必要运行时，不打包 codegraph/ModLens/Everything。

### 实现验证（2026-10-24）

- `npm run test:room` 60 项通过；`npm run typecheck:daemon` 通过。
- 打包应用 CDP 验证：任务板/新建任务/详情/失败与报告、取消后 worktree 移除而分支保留、检查器文件/Git/查找/图谱降级、BTW 提问与提升、平台新增/移除与工具检测、900×700 无页面横向溢出。
- 草稿全链路：运行创建草稿 → 卡片明细 → 逐文件应用 → 原工作区落盘；丢弃后原目录不变；hash 冲突跳过；已处理草稿卡片变灰。
- 任务端到端（fake 后端）：ready → running → failed（无文件改动）/预算暂停/越界拒绝 → report 与线程事件；worktree 测试覆盖成功提交、验证与 `--ff-only` 合并。
- 消息 ↔ 任务：来源消息跳回与高亮、消息钉入任务上下文；codegraph 可用且过期时派发前同步并注入影响清单。
- 已知边界：btw 的“无工具”是提示词 + 平台只读沙箱约束，不是独立硬沙箱；Everything 只做检测，未接入查找加速；codegraph 只在索引过期时同步。

## 7. 验收清单（整体）

- [x] 能创建命名工作区、绑定房间、重命名、注销；不删除磁盘文件夹。
- [x] 路径 `查看` 浮层可复制/点击打开；`打开文件夹` 一次点击直达。
- [x] 无工作区房间可正常聊天；任务入口禁用并解释原因。
- [x] 非 git 工作区可生成沙箱草稿并选择性应用；未应用时原目录零变化。
- [x] 新建房间/成员/平台不再落到固定 `real`。
- [x] 任务写入仅发生在 worktree；主工作区无 agent 提交。
- [x] 验证失败/审查失败/冲突/预算暂停/崩溃恢复都有明确状态和可恢复操作。
- [x] 右栏只读、可降级；codegraph 不可用不影响聊天与任务。
- [x] 旧 `demo` / `real` 房间与 journal 可继续打开和回放。

## 8. 命令与环境

```bash
# 测试与类型
npm run test:room
npm run typecheck:daemon

# 打包桌面版（Windows）
npm run desktop:local:dir
env -u ELECTRON_RUN_AS_NODE ./dist-electron-local-out/win-unpacked/AgentSpaceLocal.exe --remote-debugging-port=9223

# 数据目录（打包版）
%APPDATA%\agent-space-local\rooms
```

约束：

- 本机开发 shell 有 `ELECTRON_RUN_AS_NODE=1`，启动 GUI 前必须取消。
- `reasonix.toml` 含明文 token，不入库、不提交；GitHub token 在 `F:\Code\Traecncode\Program\API.txt`，只本地使用。
- 构建会重新生成 `packages/daemon/bin/*.js`；只提交有意义的源文件。

## 9. 决策日志

| 日期 | 决策 | 来源 |
| --- | --- | --- |
| 2026-10-24 | 本地单人房间取代团队模式 | Q1–Q22 |
| 2026-10-24 | 任务板、worktree、检查器、codegraph、btw 纳入 Workbench | 第 1–4 轮 |
| 2026-10-24 | 五区壳层、成员抽屉、石墨灰 + 琥珀、五列任务板 | U1–U4 |
| 2026-10-24 | Slice 0 只重排既有功能 | 用户确认 |
| 2026-10-24 | 工作区为独立实体；无工作区 = 纯聊天；路径双按钮；创建工作区→房间→成员；默认复制当前房间角色卡 | 本轮 Q1–Q5 |
| 2026-10-24 | 工作区切换器；路径/名称唯一且路径不可改；自动房间 id；成员可增删；非 git 必须禁用任务板 | 第二轮 Q6–Q10 |
| 2026-10-24 | 非 git = 沙箱草稿；新建工作区可同时建房间；任务入口 = 任务板 + 消息菜单 | 第三轮 Q11–Q13 |
| 2026-10-24 | 草稿选范围、放应用数据、整批逐选+hash 冲突、工作区房间默认开、草稿仅聊天产物 | 第四轮 Q14–Q18 |
| 2026-10-24 | Slice 1.5–9 实现完成：草稿、任务、worktree、执行器、任务板、检查器、codegraph、btw、平台管理 | 本轮实现 |
