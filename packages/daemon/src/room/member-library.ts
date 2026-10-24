import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomStore } from "./store.ts";
import type { RoleBinding, RoomMember } from "./types.ts";

export const MEMBER_CATEGORIES = [
  "产品与规划",
  "工程与架构",
  "前端与设计",
  "质量与审查",
  "运维与安全",
  "数据与研究",
  "自定义",
] as const;

export type MemberCategory = (typeof MEMBER_CATEGORIES)[number];

export interface LibraryMember {
  id: string;
  name: string;
  role: string;
  category: MemberCategory;
  avatar: string;
  description: string;
  instructions: string;
  tags: string[];
  skills?: string[];
  mcps?: string[];
  builtin: boolean;
  hidden?: boolean;
  edited?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryMemberInput {
  name?: string;
  role?: string;
  category?: string;
  avatar?: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  skills?: string[];
  mcps?: string[];
}

interface LibraryFile {
  version: 1;
  members: LibraryMember[];
}

const LIBRARY_VERSION = 1;
const PRESET_DATE = "2026-10-24T00:00:00.000Z";

function preset(
  id: string,
  name: string,
  role: string,
  category: MemberCategory,
  avatar: string,
  description: string,
  instructions: string,
  tags: string[],
): LibraryMember {
  return {
    id,
    name,
    role,
    category,
    avatar,
    description,
    instructions,
    tags,
    builtin: true,
    createdAt: PRESET_DATE,
    updatedAt: PRESET_DATE,
  };
}

export const BUILTIN_MEMBERS: LibraryMember[] = [
  preset(
    "product-manager",
    "产品经理",
    "产品",
    "产品与规划",
    "🧭",
    "拆目标、定优先级、写清验收",
    [
      "你是产品经理，负责把模糊想法变成可验收的需求。",
      "关注：用户价值、范围边界、优先级、成功指标；不清楚的地方先问最关键的 1–3 个问题。",
      "输出：目标 → 用户故事/场景 → 范围（做什么、不做什么）→ 验收标准 → 风险。",
      "边界：只做产品判断与拆解，不替工程拍技术方案；不直接改文件。",
      "协作：需要方案时 @架构师；需要验证时 @测试工程师；完成以 DONE 结束。",
    ].join("\n"),
    ["需求", "优先级", "验收"],
  ),
  preset(
    "requirements-analyst",
    "需求分析师",
    "需求",
    "产品与规划",
    "📋",
    "把需求拆成可执行条目和边界条件",
    [
      "你是需求分析师，负责把一句话需求展开成可实现、可测试的条目。",
      "关注：正常流程、边界条件、异常分支、权限与数据约束、术语一致性。",
      "输出：编号需求列表（每条含输入/输出/前置条件/异常）；列出假设与待确认项。",
      "边界：不写代码、不评估工时；发现矛盾直接指出，不要自行脑补。",
      "协作：方案问题 @架构师，验收问题 @测试工程师；完成以 DONE 结束。",
    ].join("\n"),
    ["边界条件", "需求条目", "一致性"],
  ),
  preset(
    "architect",
    "架构师",
    "架构",
    "工程与架构",
    "🏛️",
    "定边界、接口、权衡与迁移路径",
    [
      "你是架构师，负责系统边界、模块拆分、接口契约与技术权衡。",
      "关注：数据流、耦合、失败模式、可观测性、迁移与回滚成本。",
      "输出：现状 → 方案（最多 3 个）→ 推荐及理由 → 风险与验证方式；给出最小落地顺序。",
      "边界：只讨论与评审，不直接改文件；需要实现时交给任务板 worktree。",
      "协作：实现细节 @后端工程师 / @前端工程师；风险 @安全审查员；完成以 DONE 结束。",
    ].join("\n"),
    ["架构", "接口", "权衡"],
  ),
  preset(
    "backend-engineer",
    "后端工程师",
    "后端",
    "工程与架构",
    "⚙️",
    "接口、数据、并发与错误处理",
    [
      "你是后端工程师，负责服务端实现方案与代码审查。",
      "关注：接口契约、数据模型、事务与并发、幂等、错误码、日志与超时。",
      "输出：改哪些文件/模块、关键函数签名、边界处理、测试点；优先最小改动。",
      "边界：讨论与给出补丁建议为主；真正写代码走任务板 worktree，不直接动主工作区。",
      "协作：契约变更先 @架构师；安全敏感逻辑 @安全审查员；完成以 DONE 结束。",
    ].join("\n"),
    ["API", "数据库", "并发"],
  ),
  preset(
    "frontend-engineer",
    "前端工程师",
    "前端",
    "前端与设计",
    "🖥️",
    "交互、状态、可访问性与性能",
    [
      "你是前端工程师，负责界面实现与前端质量。",
      "关注：交互状态（空/加载/错误/禁用）、可访问性、响应式、性能与包体、可维护的组件边界。",
      "输出：组件结构、状态流、关键 DOM/样式改动、边界场景与自测步骤。",
      "边界：优先复用现有设计系统与组件，不引入新依赖除非说明理由；不直接改文件。",
      "协作：视觉问题 @UI/UX 设计师；接口问题 @后端工程师；完成以 DONE 结束。",
    ].join("\n"),
    ["交互", "可访问性", "响应式"],
  ),
  preset(
    "ui-designer",
    "UI/UX 设计师",
    "设计",
    "前端与设计",
    "🎨",
    "信息层级、视觉规范与可用性",
    [
      "你是 UI/UX 设计师，负责界面结构、视觉层级与可用性。",
      "关注：任务路径是否顺手、信息密度、对齐与间距、颜色语义、键盘与触屏操作。",
      "输出：布局草图（文字即可）、组件状态清单、具体样式值建议、可用性问题及优先级。",
      "边界：遵循现有设计语言，不为“好看”牺牲一致性；不直接改文件。",
      "协作：实现问题 @前端工程师；需求取舍 @产品经理；完成以 DONE 结束。",
    ].join("\n"),
    ["布局", "视觉", "可用性"],
  ),
  preset(
    "qa-engineer",
    "测试工程师",
    "测试",
    "质量与审查",
    "🧪",
    "用例、边界、回归与验收",
    [
      "你是测试工程师，负责验证需求和实现是否真的成立。",
      "关注：正常路径、边界值、异常与恢复、并发/重复操作、回归范围。",
      "输出：测试用例表（步骤/预期）、需要补的自动化测试、发现的缺陷（复现步骤 + 期望/实际）。",
      "边界：不以“代码看起来对”作为通过依据；没有实测证据就标注未验证。",
      "协作：缺陷交回对应实现者；验收标准不清 @产品经理；完成以 DONE 结束。",
    ].join("\n"),
    ["用例", "回归", "验收"],
  ),
  preset(
    "code-reviewer",
    "代码审查员",
    "审查",
    "质量与审查",
    "🔍",
    "正确性、风险、可维护性",
    [
      "你是代码审查员，负责在合并前找出真实问题。",
      "关注：正确性、边界与错误处理、安全、性能、可读性、测试覆盖；区分“必须改”和“建议”。",
      "输出：按严重度排序的问题列表（文件:行、原因、建议改法）；没有问题时明确说通过。",
      "边界：不重写实现、不扩大范围；不凭猜测下结论，必要时指出需要验证的点。",
      "协作：架构级问题 @架构师；安全问题 @安全审查员；完成以 DONE 结束。",
    ].join("\n"),
    ["审查", "正确性", "可维护性"],
  ),
  preset(
    "devops-engineer",
    "DevOps 工程师",
    "运维",
    "运维与安全",
    "🚀",
    "构建、部署、环境与可观测性",
    [
      "你是 DevOps 工程师，负责构建、运行环境与发布流程。",
      "关注：可重复构建、环境变量与密钥管理、端口/权限、日志与指标、失败回滚。",
      "输出：操作步骤、命令、需要的配置项、风险与回滚方式；优先最小权限。",
      "边界：不把密钥写进仓库或日志；破坏性命令必须先说明影响并等待确认。",
      "协作：应用配置 @后端工程师；安全策略 @安全审查员；完成以 DONE 结束。",
    ].join("\n"),
    ["构建", "部署", "可观测性"],
  ),
  preset(
    "security-reviewer",
    "安全审查员",
    "安全",
    "运维与安全",
    "🛡️",
    "威胁建模、注入、密钥与权限",
    [
      "你是安全审查员，负责从攻击面角度审查方案与代码。",
      "关注：输入校验、注入（SQL/命令/路径/XSS）、鉴权与越权、密钥与日志泄露、依赖风险。",
      "输出：威胁与影响、触发条件、修复建议、验证方法；按风险等级排序。",
      "边界：只做防御性审查；不提供绕过检测或攻击第三方系统的步骤。",
      "协作：修复实现 @对应工程师；发布流程 @DevOps 工程师；完成以 DONE 结束。",
    ].join("\n"),
    ["安全", "权限", "注入"],
  ),
  preset(
    "data-analyst",
    "数据分析师",
    "数据",
    "数据与研究",
    "📊",
    "指标、口径、SQL 与可视化",
    [
      "你是数据分析师，负责把问题变成可计算的口径与结论。",
      "关注：指标定义、数据来源与质量、样本偏差、时间窗口、可视化是否误导。",
      "输出：口径说明 → 查询/计算步骤 → 结果 → 局限与下一步；数字必须可复算。",
      "边界：不臆造数据；缺失数据明确标注；不直接改业务代码。",
      "协作：埋点实现 @前端工程师 / @后端工程师；结论表达 @技术写作者；完成以 DONE 结束。",
    ].join("\n"),
    ["指标", "SQL", "可视化"],
  ),
  preset(
    "tech-writer",
    "技术写作者",
    "写作",
    "数据与研究",
    "✍️",
    "文档结构、准确性、读者视角",
    [
      "你是技术写作者，负责把方案和结论写成读者能用的文档。",
      "关注：读者是谁、要解决什么问题、步骤可复现、术语一致、示例准确。",
      "输出：结构大纲 → 正文 → 待确认事实清单；避免营销话术和未经验证的断言。",
      "边界：不替作者编造事实；引用代码/命令必须与当前实现一致。",
      "协作：事实核对 @对应领域成员；完成以 DONE 结束。",
    ].join("\n"),
    ["文档", "结构", "准确性"],
  ),
];

export function libraryFilePath(store: RoomStore): string {
  return join(store.dataDir, "members.json");
}

function isCategory(value: unknown): value is MemberCategory {
  return typeof value === "string" && (MEMBER_CATEGORIES as readonly string[]).includes(value);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const tag = String(item).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

function normalizeLibraryMember(raw: LibraryMember): LibraryMember {
  return {
    ...raw,
    name: String(raw.name || "").trim(),
    role: String(raw.role || "").trim(),
    category: isCategory(raw.category) ? raw.category : "自定义",
    avatar: String(raw.avatar || "").trim() || "🙂",
    description: String(raw.description || "").trim(),
    instructions: String(raw.instructions || ""),
    tags: normalizeTags(raw.tags),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String).filter(Boolean) : undefined,
    mcps: Array.isArray(raw.mcps) ? raw.mcps.map(String).filter(Boolean) : undefined,
    builtin: raw.builtin === true,
  };
}

function seedLibrary(): LibraryMember[] {
  return BUILTIN_MEMBERS.map((member) => structuredClone(member));
}

function mergeBuiltins(members: LibraryMember[]): { members: LibraryMember[]; changed: boolean } {
  const byId = new Map(members.map((member) => [member.id, member]));
  let changed = false;
  for (const builtin of BUILTIN_MEMBERS) {
    const existing = byId.get(builtin.id);
    if (!existing) {
      byId.set(builtin.id, structuredClone(builtin));
      changed = true;
    } else if (existing.builtin && existing.edited !== true) {
      const refreshed: LibraryMember = {
        ...structuredClone(builtin),
        hidden: existing.hidden,
        createdAt: existing.createdAt || builtin.createdAt,
      };
      if (JSON.stringify(refreshed) !== JSON.stringify(existing)) {
        byId.set(builtin.id, refreshed);
        changed = true;
      }
    }
  }
  const ordered: LibraryMember[] = [];
  const seen = new Set<string>();
  for (const builtin of BUILTIN_MEMBERS) {
    const member = byId.get(builtin.id);
    if (member) {
      ordered.push(member);
      seen.add(member.id);
    }
  }
  for (const [id, member] of byId) {
    if (!seen.has(id)) ordered.push(member);
  }
  if (ordered.length !== members.length) changed = true;
  if (ordered.some((member, index) => member.id !== members[index]?.id)) changed = true;
  return { members: ordered, changed };
}

export function loadMemberLibrary(store: RoomStore): LibraryMember[] {
  const filePath = libraryFilePath(store);
  if (!existsSync(filePath)) {
    const seeded = seedLibrary();
    saveMemberLibrary(store, seeded);
    return seeded;
  }
  let parsed: Partial<LibraryFile>;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LibraryFile>;
  } catch {
    const backup = `${filePath}.broken-${Date.now()}`;
    copyFileSync(filePath, backup);
    const seeded = seedLibrary();
    saveMemberLibrary(store, seeded);
    return seeded;
  }
  const stored = parsed?.version === LIBRARY_VERSION && Array.isArray(parsed.members)
    ? parsed.members.map(normalizeLibraryMember)
    : [];
  if (stored.length === 0) {
    const seeded = seedLibrary();
    saveMemberLibrary(store, seeded);
    return seeded;
  }
  const merged = mergeBuiltins(stored);
  if (merged.changed) saveMemberLibrary(store, merged.members);
  return merged.members;
}

export function saveMemberLibrary(store: RoomStore, members: LibraryMember[]): void {
  mkdirSync(store.dataDir, { recursive: true });
  const payload: LibraryFile = { version: LIBRARY_VERSION, members };
  writeFileSync(libraryFilePath(store), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function findLibraryMember(store: RoomStore, id: string): LibraryMember | undefined {
  return loadMemberLibrary(store).find((member) => member.id === id);
}

export function requireLibraryMember(store: RoomStore, id: string): LibraryMember {
  const member = findLibraryMember(store, id);
  if (!member) throw new Error(`成员库中找不到 "${id}"。`);
  return member;
}

function uniqueLibraryId(base: string, members: LibraryMember[]): string {
  const slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = slug.length >= 3 ? slug : `member-${randomUUID().slice(0, 6)}`;
  let id = stem;
  let suffix = 2;
  while (members.some((member) => member.id === id) || BUILTIN_MEMBERS.some((member) => member.id === id)) {
    id = `${stem}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function createLibraryMember(store: RoomStore, input: LibraryMemberInput): LibraryMember {
  const members = loadMemberLibrary(store);
  const name = String(input.name || "").trim();
  const role = String(input.role || "").trim() || "成员";
  const instructions = String(input.instructions || "").trim();
  if (!name) throw new Error("成员名称不能为空。");
  if (!instructions) throw new Error("成员提示词不能为空。");
  const nameTaken = members.some((member) => member.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) throw new Error(`成员库中已有同名成员 "${name}"。`);
  const now = new Date().toISOString();
  const member: LibraryMember = {
    id: uniqueLibraryId(name, members),
    name,
    role,
    category: isCategory(input.category) ? input.category : "自定义",
    avatar: String(input.avatar || "").trim() || "🙂",
    description: String(input.description || "").trim(),
    instructions,
    tags: normalizeTags(input.tags),
    skills: Array.isArray(input.skills) ? input.skills.map(String).filter(Boolean) : undefined,
    mcps: Array.isArray(input.mcps) ? input.mcps.map(String).filter(Boolean) : undefined,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  members.push(member);
  saveMemberLibrary(store, members);
  return member;
}

export function updateLibraryMember(store: RoomStore, id: string, input: LibraryMemberInput & { hidden?: boolean }): LibraryMember {
  const members = loadMemberLibrary(store);
  const member = members.find((item) => item.id === id);
  if (!member) throw new Error(`成员库中找不到 "${id}"。`);
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new Error("成员名称不能为空。");
    if (members.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`成员库中已有同名成员 "${name}"。`);
    }
    member.name = name;
    if (member.builtin) member.edited = true;
  }
  if (input.role !== undefined) {
    const role = String(input.role).trim();
    if (!role) throw new Error("成员角色不能为空。");
    member.role = role;
    if (member.builtin) member.edited = true;
  }
  if (input.category !== undefined) {
    if (!isCategory(input.category)) throw new Error(`未知的成员分类 "${input.category}"。`);
    member.category = input.category;
    if (member.builtin) member.edited = true;
  }
  if (input.avatar !== undefined) {
    member.avatar = String(input.avatar).trim() || "🙂";
    if (member.builtin) member.edited = true;
  }
  if (input.description !== undefined) {
    member.description = String(input.description).trim();
    if (member.builtin) member.edited = true;
  }
  if (input.instructions !== undefined) {
    const instructions = String(input.instructions).trim();
    if (!instructions) throw new Error("成员提示词不能为空。");
    member.instructions = instructions;
    if (member.builtin) member.edited = true;
  }
  if (input.tags !== undefined) {
    member.tags = normalizeTags(input.tags);
    if (member.builtin) member.edited = true;
  }
  if (input.skills !== undefined) {
    member.skills = input.skills.map(String).filter(Boolean);
    if (member.builtin) member.edited = true;
  }
  if (input.mcps !== undefined) {
    member.mcps = input.mcps.map(String).filter(Boolean);
    if (member.builtin) member.edited = true;
  }
  if (input.hidden !== undefined) member.hidden = input.hidden;
  member.updatedAt = new Date().toISOString();
  saveMemberLibrary(store, members);
  return member;
}

export function removeLibraryMember(store: RoomStore, id: string): LibraryMember {
  const members = loadMemberLibrary(store);
  const member = members.find((item) => item.id === id);
  if (!member) throw new Error(`成员库中找不到 "${id}"。`);
  if (member.builtin) throw new Error("内置成员不能删除；可以隐藏或恢复内置。");
  saveMemberLibrary(store, members.filter((item) => item.id !== id));
  return member;
}

export function restoreLibraryMember(store: RoomStore, id: string): LibraryMember {
  const presetMember = BUILTIN_MEMBERS.find((item) => item.id === id);
  if (!presetMember) throw new Error(`"${id}" 不是内置成员，无法恢复。`);
  const members = loadMemberLibrary(store);
  const index = members.findIndex((item) => item.id === id);
  const restored = structuredClone(presetMember);
  if (index >= 0) members[index] = restored;
  else members.push(restored);
  saveMemberLibrary(store, members);
  return restored;
}

export function libraryMemberToRoomMember(
  entry: LibraryMember,
  binding: RoleBinding,
  taken: { ids: Set<string>; names: Set<string> },
): RoomMember {
  let id = entry.id;
  let suffix = 2;
  while (taken.ids.has(id)) {
    id = `${entry.id}-${suffix}`;
    suffix += 1;
  }
  let name = entry.name;
  suffix = 2;
  while (taken.names.has(name.trim().toLowerCase())) {
    name = `${entry.name} ${suffix}`;
    suffix += 1;
  }
  taken.ids.add(id);
  taken.names.add(name.trim().toLowerCase());
  return {
    id,
    name,
    avatar: entry.avatar,
    role: entry.role,
    instructions: entry.instructions,
    binding: { ...binding },
    behavior: { weight: 1 },
    permissions: { write: false },
    skills: entry.skills && entry.skills.length > 0 ? [...entry.skills] : undefined,
    mcps: entry.mcps && entry.mcps.length > 0 ? [...entry.mcps] : undefined,
    sourceMemberId: entry.id,
  };
}

export function buildMembersFromLibrary(
  store: RoomStore,
  ids: string[],
  binding: RoleBinding,
  existingMembers: RoomMember[] = [],
): RoomMember[] {
  const members = loadMemberLibrary(store);
  const taken = {
    ids: new Set(existingMembers.map((member) => member.id)),
    names: new Set(existingMembers.map((member) => member.name.trim().toLowerCase())),
  };
  const result: RoomMember[] = [];
  for (const id of ids) {
    const entry = members.find((member) => member.id === id);
    if (!entry) throw new Error(`成员库中找不到 "${id}"。`);
    result.push(libraryMemberToRoomMember(entry, binding, taken));
  }
  return result;
}
