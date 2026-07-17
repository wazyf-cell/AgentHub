"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  AutoContinuationRunRecord,
  AutomationsPageData,
  ChannelDocumentRunRecord,
  CodeDevelopmentSessionViewRecord,
  CollaborationRunViewRecord,
  PanelDiscussionViewRecord,
} from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type {
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  AutomationConditionOperator,
} from "@agent-space/domain/workspace";
import {
  createAutomationRuleAction,
  toggleAutomationRuleAction,
  deleteAutomationRuleAction,
  stopAutoContinuationAction,
} from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { EmptyState } from "@/shared/ui/empty-state";
import { formatCompactTimestamp } from "@/shared/lib/time-format";

const TRIGGER_TYPES: Array<{ value: AutomationTriggerType; label: string; labelEn: string }> = [
  { value: "message_received", label: "消息到达", labelEn: "Message Received" },
  { value: "task_completed", label: "任务完成", labelEn: "Task Completed" },
  { value: "document_updated", label: "文档更新", labelEn: "Document Updated" },
  { value: "schedule", label: "定时触发", labelEn: "Schedule" },
];

const ACTION_TYPES: Array<{ value: AutomationActionType; label: string; labelEn: string }> = [
  { value: "send_message", label: "发送消息", labelEn: "Send Message" },
  { value: "create_task", label: "创建任务", labelEn: "Create Task" },
  { value: "mention_agent", label: "@Agent", labelEn: "@Agent" },
  { value: "update_table", label: "更新数据表", labelEn: "Update Table" },
  { value: "webhook", label: "Webhook", labelEn: "Webhook" },
];

const CONDITION_OPERATORS: Array<{ value: AutomationConditionOperator; label: string; labelEn: string }> = [
  { value: "contains", label: "包含", labelEn: "Contains" },
  { value: "equals", label: "等于", labelEn: "Equals" },
  { value: "matches", label: "匹配正则", labelEn: "Matches" },
];

const CONDITION_FIELDS: Array<{ value: string; label: string; labelEn: string; placeholder: string; placeholderEn: string }> = [
  {
    value: "message.text",
    label: "消息内容",
    labelEn: "Message text",
    placeholder: "例如：然后、报销、客户投诉",
    placeholderEn: "Example: then, invoice, customer complaint",
  },
  {
    value: "message.channel",
    label: "所在群组",
    labelEn: "Channel",
    placeholder: "例如：general、sales",
    placeholderEn: "Example: general, sales",
  },
  {
    value: "task.status",
    label: "任务状态",
    labelEn: "Task status",
    placeholder: "例如：completed",
    placeholderEn: "Example: completed",
  },
  {
    value: "document.title",
    label: "文档标题",
    labelEn: "Document title",
    placeholder: "例如：周报、计划",
    placeholderEn: "Example: report, plan",
  },
];

const RUN_STATUS_LABELS: Record<ChannelDocumentRunRecord["status"], { label: string; labelEn: string }> = {
  pending: { label: "等待中", labelEn: "Pending" },
  running: { label: "运行中", labelEn: "Running" },
  completed: { label: "已完成", labelEn: "Completed" },
  completed_with_warning: { label: "有警告", labelEn: "Warning" },
  failed: { label: "失败", labelEn: "Failed" },
};

const AUTO_CONTINUATION_STATUS_LABELS: Record<AutoContinuationRunRecord["status"], { label: string; labelEn: string; badge: string }> = {
  active: { label: "运行中", labelEn: "Active", badge: "running" },
  expired: { label: "已结束", labelEn: "Expired", badge: "completed" },
  stopped: { label: "已停止", labelEn: "Stopped", badge: "disabled" },
};

const COLLABORATION_RUN_STATUS_LABELS: Record<CollaborationRunViewRecord["status"], { label: string; labelEn: string; badge: string }> = {
  draft: { label: "草稿", labelEn: "Draft", badge: "disabled" },
  approved: { label: "已批准", labelEn: "Approved", badge: "queued" },
  running: { label: "运行中", labelEn: "Running", badge: "running" },
  completed: { label: "已完成", labelEn: "Completed", badge: "completed" },
  failed: { label: "失败", labelEn: "Failed", badge: "failed" },
  cancelled: { label: "已取消", labelEn: "Cancelled", badge: "cancelled" },
};

const COLLABORATION_NODE_STATUS_LABELS: Record<CollaborationRunViewRecord["nodes"][number]["status"], { label: string; labelEn: string; badge: string }> = {
  pending: { label: "等待依赖", labelEn: "Pending", badge: "disabled" },
  ready: { label: "可派发", labelEn: "Ready", badge: "queued" },
  queued: { label: "已入队", labelEn: "Queued", badge: "queued" },
  running: { label: "执行中", labelEn: "Running", badge: "running" },
  completed: { label: "已完成", labelEn: "Completed", badge: "completed" },
  failed: { label: "失败", labelEn: "Failed", badge: "failed" },
  blocked: { label: "已阻断", labelEn: "Blocked", badge: "failed" },
  cancelled: { label: "已取消", labelEn: "Cancelled", badge: "cancelled" },
};

const COLLABORATION_REVIEW_STATUS_LABELS: Record<NonNullable<CollaborationRunViewRecord["nodes"][number]["reviewStatus"]>, { label: string; labelEn: string }> = {
  accepted: { label: "已验收", labelEn: "Accepted" },
  rejected: { label: "已驳回", labelEn: "Rejected" },
  needs_revision: { label: "需修改", labelEn: "Needs revision" },
};

const PANEL_DISCUSSION_STATUS_LABELS: Record<PanelDiscussionViewRecord["status"], { label: string; labelEn: string; badge: string }> = {
  open: { label: "讨论中", labelEn: "Open", badge: "running" },
  decided: { label: "已决策", labelEn: "Decided", badge: "completed" },
};

const CODE_DEVELOPMENT_STATUS_LABELS: Record<CodeDevelopmentSessionViewRecord["status"], { label: string; labelEn: string; badge: string }> = {
  planned: { label: "已规划", labelEn: "Planned", badge: "queued" },
  running: { label: "开发中", labelEn: "Running", badge: "running" },
  patch_ready: { label: "Patch 待审", labelEn: "Patch ready", badge: "queued" },
  reviewed: { label: "已审查", labelEn: "Reviewed", badge: "completed" },
  merged: { label: "已合并", labelEn: "Merged", badge: "completed" },
  blocked: { label: "已阻塞", labelEn: "Blocked", badge: "failed" },
  cancelled: { label: "已取消", labelEn: "Cancelled", badge: "cancelled" },
};

const BUILTIN_SEQUENCE_RULE_ID = "builtin:channel-sequential-then";
const BUILTIN_AUTO_CONTINUATION_RULE_ID = "builtin:auto-continuation-until";
const BUILTIN_COLLABORATION_ORCHESTRATOR_RULE_ID = "builtin:collaboration-orchestrator";
const BUILTIN_SAFE_CODE_DEVELOPMENT_RULE_ID = "builtin:safe-code-development";

function getConditionFieldLabel(field: string, tx: (zh: string, en: string) => string): string {
  const option = CONDITION_FIELDS.find((item) => item.value === field);
  return option ? tx(option.label, option.labelEn) : field;
}

function getConditionOperatorLabel(operator: AutomationConditionOperator, tx: (zh: string, en: string) => string): string {
  const option = CONDITION_OPERATORS.find((item) => item.value === operator);
  return option ? tx(option.label, option.labelEn) : operator;
}

function getQueueStatusLabel(status: string | undefined, tx: (zh: string, en: string) => string): string {
  switch (status) {
    case "queued":
      return tx("排队中", "Queued");
    case "claimed":
      return tx("已认领", "Claimed");
    case "running":
      return tx("执行中", "Running");
    case "completed":
      return tx("已完成", "Completed");
    case "failed":
      return tx("失败", "Failed");
    case "cancelled":
      return tx("已取消", "Cancelled");
    default:
      return tx("无队列任务", "No queued task");
  }
}

export function AutomationsPageClient({ data, onDataChanged }: { data: AutomationsPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createTriggerType, setCreateTriggerType] = useState<AutomationTriggerType>("message_received");
  const [createConditionField, setCreateConditionField] = useState("message.text");
  const [createConditionOperator, setCreateConditionOperator] = useState<AutomationConditionOperator>("contains");
  const [createConditionValue, setCreateConditionValue] = useState("");
  const [createActionType, setCreateActionType] = useState<AutomationActionType>("send_message");
  const [isPending, startTransition] = useTransition();
  const selectedRule = data.rules.find((rule) => rule.id === selectedId);
  const selectedBuiltinSequenceRule = selectedId === BUILTIN_SEQUENCE_RULE_ID;
  const selectedBuiltinAutoContinuationRule = selectedId === BUILTIN_AUTO_CONTINUATION_RULE_ID;
  const selectedBuiltinCollaborationRule = selectedId === BUILTIN_COLLABORATION_ORCHESTRATOR_RULE_ID;
  const selectedBuiltinSafeCodeDevelopmentRule = selectedId === BUILTIN_SAFE_CODE_DEVELOPMENT_RULE_ID;
  const activeAutoContinuationRuns = data.autoContinuationRuns.filter((run) => run.status === "active");
  const activeCollaborationRuns = data.collaborationRuns.filter((run) => run.status === "running" || run.status === "approved");
  const openPanelDiscussions = data.panelDiscussions.filter((discussion) => discussion.status === "open");
  const activeCodeDevelopmentSessions = data.codeDevelopmentSessions.filter((session) =>
    session.status === "planned" || session.status === "running" || session.status === "patch_ready" || session.status === "reviewed"
  );
  const selectedConditionField = CONDITION_FIELDS.find((field) => field.value === createConditionField) ?? CONDITION_FIELDS[0]!;
  const selectedTriggerLabel = TRIGGER_TYPES.find((trigger) => trigger.value === createTriggerType);
  const selectedOperatorLabel = CONDITION_OPERATORS.find((operator) => operator.value === createConditionOperator);
  const selectedActionLabel = ACTION_TYPES.find((action) => action.value === createActionType);

  function handleCreate(): void {
    if (!createName.trim()) return;
    const conditionValue = createConditionValue.trim();
    startTransition(async () => {
      await createAutomationRuleAction({
        name: createName.trim(),
        description: createDescription.trim(),
        trigger: { type: createTriggerType, config: {} },
        conditions: conditionValue
          ? [
              {
                field: createConditionField.trim() || "message.text",
                operator: createConditionOperator,
                value: conditionValue,
              },
            ]
          : [],
        actions: [{ type: createActionType, config: {} }],
      });
      setShowCreateModal(false);
      setCreateName("");
      setCreateDescription("");
      setCreateConditionField("message.text");
      setCreateConditionOperator("contains");
      setCreateConditionValue("");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleToggle(rule: AutomationRule): void {
    startTransition(async () => {
      await toggleAutomationRuleAction(rule.id, !rule.enabled);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteAutomationRuleAction(id);
      if (selectedId === id) setSelectedId(null);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleStopAutoContinuation(run: AutoContinuationRunRecord): void {
    startTransition(async () => {
      await stopAutoContinuationAction({
        channelName: run.channelName,
        agentId: run.agentId,
        contactId: run.contactId,
      });
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  return (
    <section className="page-shell automations-page">
      <div className="automations-layout">
        <div className="automations-header">
          <div>
            <h1>{tx("自动化工作流", "Automations")}</h1>
            <p className="automations-header__subtitle">
              {tx(
                `${data.totalCount} 条规则，${data.enabledCount} 条启用`,
                `${data.totalCount} rules, ${data.enabledCount} enabled`,
              )}
            </p>
          </div>
          <button
            className="knowledge-btn knowledge-btn--primary"
            onClick={() => setShowCreateModal(true)}
            type="button"
          >
            {tx("+ 新建规则", "+ New Rule")}
          </button>
        </div>

        <div className="automations-list">
          <>
            <div
              className={`automations-card${selectedBuiltinSequenceRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinSequenceRule ? null : BUILTIN_SEQUENCE_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("然后", "Then")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                </div>
              </div>
              <p className="automations-card__description">
                {tx("群消息里按顺序 @ 多个 Agent 时，识别“然后”等顺序词并启动串行协作。", "Starts sequential collaboration when a channel message mentions multiple agents with markers such as then.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("群消息提及", "Channel mention")}</span>
                <span className="automations-card__conditions">→ {tx("包含 然后 / 再 / 之后", "contains then / next / after")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("串行协作", "Sequential collaboration")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("运行实例", "Runs")}: {data.documentRunCount}
              </div>
            </div>

            <div
              className={`automations-card${selectedBuiltinAutoContinuationRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinAutoContinuationRule ? null : BUILTIN_AUTO_CONTINUATION_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("做…直到", "Do until")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                  {activeAutoContinuationRuns.length > 0 ? (
                    <span className="automations-card__badge automations-card__badge--run-running">
                      {tx(`${activeAutoContinuationRuns.length} 个运行中`, `${activeAutoContinuationRuns.length} active`)}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="automations-card__description">
                {tx("群消息 @ 单个 Agent 并要求连续工作、持续工作或自动接管到某个时间时，持续排队下一轮任务直到截止。", "Keeps queueing follow-up work until a deadline when a channel message asks one agent to keep working or take over.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("群消息提及", "Channel mention")}</span>
                <span className="automations-card__conditions">→ {tx("包含 连续工作 / 自动接管 / 接管到", "contains keep working / take over / until")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("自动续跑", "Auto continuation")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("运行实例", "Runs")}: {data.autoContinuationRunCount}
              </div>
              {activeAutoContinuationRuns.length > 0 ? (
                <div className="automations-card__active-runs">
                  {activeAutoContinuationRuns.map((run) => (
                    <button
                      className="knowledge-btn knowledge-btn--danger"
                      disabled={isPending}
                      key={run.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleStopAutoContinuation(run);
                      }}
                      type="button"
                    >
                      {isPending
                        ? tx("停止中...", "Stopping...")
                        : tx(`停止 ${run.agentId}`, `Stop ${run.agentId}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div
              className={`automations-card${selectedBuiltinCollaborationRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinCollaborationRule ? null : BUILTIN_COLLABORATION_ORCHESTRATOR_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("多 Agent 编排", "Multi-agent orchestration")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                  {activeCollaborationRuns.length > 0 ? (
                    <span className="automations-card__badge automations-card__badge--run-running">
                      {tx(`${activeCollaborationRuns.length} 个运行中`, `${activeCollaborationRuns.length} active`)}
                    </span>
                  ) : null}
                  {openPanelDiscussions.length > 0 ? (
                    <span className="automations-card__badge automations-card__badge--run-running">
                      {tx(`${openPanelDiscussions.length} 个讨论中`, `${openPanelDiscussions.length} discussions`)}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="automations-card__description">
                {tx("通过 CollaborationRun DAG 按依赖调度多个 Agent，daemon 完成节点后自动推进下游任务。", "Creates CollaborationRun DAGs, dispatches agents by dependency, and advances downstream tasks after daemon completion.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("API 创建", "API create")}</span>
                <span className="automations-card__conditions">→ {tx("依赖 DAG", "dependency DAG")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("自动派发与推进", "Dispatch and advance")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("运行实例", "Runs")}: {data.collaborationRunCount}
                {` · ${tx("Panel 讨论", "Panel discussions")}: ${data.panelDiscussionCount}`}
              </div>
            </div>

            <div
              className={`automations-card${selectedBuiltinSafeCodeDevelopmentRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinSafeCodeDevelopmentRule ? null : BUILTIN_SAFE_CODE_DEVELOPMENT_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("安全并行开发", "Safe parallel development")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                  {activeCodeDevelopmentSessions.length > 0 ? (
                    <span className="automations-card__badge automations-card__badge--run-running">
                      {tx(`${activeCodeDevelopmentSessions.length} 个会话`, `${activeCodeDevelopmentSessions.length} sessions`)}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="automations-card__description">
                {tx("记录多 Agent 代码开发必须使用的隔离 worktree、patch 摘要和合并前审查状态，避免多个 Agent 直接覆盖同一个代码树。", "Tracks isolated worktrees, patch summaries, and pre-merge review state so multiple agents do not overwrite the same code tree.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("隔离 worktree", "Isolated worktree")}</span>
                <span className="automations-card__conditions">→ {tx("Patch 待审", "Patch review")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("人工合并确认", "Manual merge gate")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("开发会话", "Development sessions")}: {data.codeDevelopmentSessionCount}
              </div>
            </div>

              {data.rules.map((rule) => (
                <div
                  className={`automations-card${selectedId === rule.id ? " automations-card--selected" : ""}`}
                  key={rule.id}
                  onClick={() => setSelectedId(selectedId === rule.id ? null : rule.id)}
                >
                  <div className="automations-card__header">
                    <div className="automations-card__title">
                      <strong>{rule.name}</strong>
                      <span className={`automations-card__badge automations-card__badge--${rule.enabled ? "enabled" : "disabled"}`}>
                        {rule.enabled ? tx("启用", "Enabled") : tx("停用", "Paused")}
                      </span>
                    </div>
                    <div className="automations-card__actions">
                      <button
                        className="knowledge-btn knowledge-btn--ghost"
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggle(rule);
                        }}
                        type="button"
                      >
                        {rule.enabled ? tx("停用", "Pause") : tx("启用", "Enable")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--danger"
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(rule.id);
                        }}
                        type="button"
                      >
                        {tx("删除", "Delete")}
                      </button>
                    </div>
                  </div>
                  {rule.description ? (
                    <p className="automations-card__description">{rule.description}</p>
                  ) : null}
                  <div className="automations-card__flow">
                    <span className="automations-card__trigger">
                      {TRIGGER_TYPES.find((t) => t.value === rule.trigger.type)?.label ?? rule.trigger.type}
                    </span>
                    {rule.conditions.length > 0 ? (
                      <span className="automations-card__conditions">
                        → {rule.conditions.length} {tx("条件", "conditions")}
                      </span>
                    ) : null}
                    <span className="automations-card__arrow">→</span>
                    {rule.actions.map((action, i) => (
                      <span className="automations-card__action" key={i}>
                        {ACTION_TYPES.find((a) => a.value === action.type)?.label ?? action.type}
                      </span>
                    ))}
                  </div>
                  <div className="automations-card__meta">
                    {tx("执行次数", "Runs")}: {rule.runCount}
                    {rule.lastTriggeredAt
                      ? ` · ${tx("最近触发", "Last run")}: ${formatCompactTimestamp(rule.lastTriggeredAt, { emptyFallback: rule.lastTriggeredAt })}`
                      : ""}
                  </div>
                </div>
              ))}
          </>
        </div>

        {selectedBuiltinSequenceRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("然后", "Then")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条规则由群聊消息解析器触发。命中后会创建串行群文档协作流程，并按顺序调度相关 Agent。", "This rule is triggered by the channel message parser. When matched, it creates a sequential channel-document workflow and dispatches agents in order.")}
            </p>
            <div className="automations-run-list">
              {data.documentRuns.length === 0 ? (
                <EmptyState
                  body={tx("还没有由这条规则触发的协作流程。", "No workflow runs have been triggered by this rule yet.")}
                  eyebrow={tx("运行实例", "Runs")}
                  title={tx("暂无运行记录", "No runs yet")}
                  variant="warm"
                />
              ) : (
                data.documentRuns.map((run) => {
                  const statusLabel = RUN_STATUS_LABELS[run.status];
                  return (
                    <div className="automations-run" key={run.id}>
                      <div className="automations-run__header">
                        <strong>{tx(`群聊协作 · ${run.channelName}`, `Chat collaboration · ${run.channelName}`)}</strong>
                        <span className={`automations-card__badge automations-card__badge--run-${run.status}`}>
                          {tx(statusLabel.label, statusLabel.labelEn)}
                        </span>
                      </div>
                      <p>{run.sourceSummary}</p>
                      <div className="automations-card__flow">
                        {run.steps.map((step, index) => (
                          <span className="automations-card__action" key={step.id}>
                            {index + 1}. {step.agentLabel}
                          </span>
                        ))}
                      </div>
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(run.updatedAt, { emptyFallback: run.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedBuiltinAutoContinuationRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("做…直到", "Do until")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条规则由群聊消息解析器触发。命中后会在当前会话执行空间里保持自动续跑状态，每轮任务完成后继续调度同一个 Agent，直到截止时间。", "This rule is triggered by the channel message parser. It keeps an auto-continuation state in the conversation workspace and dispatches the same agent after each task until the deadline.")}
            </p>
            <div className="automations-run-list">
              {data.autoContinuationRuns.length === 0 ? (
                <EmptyState
                  body={tx("还没有由这条规则触发的自动续跑会话。", "No auto-continuation sessions have been triggered by this rule yet.")}
                  eyebrow={tx("运行实例", "Runs")}
                  title={tx("暂无运行记录", "No runs yet")}
                  variant="warm"
                />
              ) : (
                data.autoContinuationRuns.map((run) => {
                  const statusLabel = AUTO_CONTINUATION_STATUS_LABELS[run.status];
                  return (
                    <div className="automations-run" key={run.id}>
                      <div className="automations-run__header">
                        <strong>{tx(`自动续跑 · ${run.channelName} · ${run.agentId}`, `Auto continuation · ${run.channelName} · ${run.agentId}`)}</strong>
                        <div className="automations-run__header-actions">
                          <span className={`automations-card__badge automations-card__badge--run-${statusLabel.badge}`}>
                            {tx(statusLabel.label, statusLabel.labelEn)}
                          </span>
                          {run.status === "active" ? (
                            <button
                              className="knowledge-btn knowledge-btn--danger"
                              disabled={isPending}
                              onClick={() => handleStopAutoContinuation(run)}
                              type="button"
                            >
                              {isPending ? tx("停止中...", "Stopping...") : tx("停止", "Stop")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p>{run.instruction}</p>
                      <div className="automations-card__flow">
                        <span className="automations-card__action">{run.agentId}</span>
                        <span className="automations-card__conditions">
                          → {tx("迭代", "Iteration")} {run.iteration}
                        </span>
                        <span className="automations-card__conditions">
                          → {tx("队列", "Queue")}: {getQueueStatusLabel(run.lastTaskStatus, tx)}
                        </span>
                        <span className="automations-card__conditions">
                          → {tx("截止", "Until")}: {formatCompactTimestamp(run.until, { emptyFallback: run.until })}
                        </span>
                      </div>
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(run.updatedAt, { emptyFallback: run.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedBuiltinCollaborationRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("多 Agent 编排", "Multi-agent orchestration")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条入口用于查看由 Orchestrator API 创建的 CollaborationRun。每个 run 由多个节点组成，节点完成后系统会按依赖自动派发后续节点。", "This entry shows CollaborationRuns created by the Orchestrator API. Each run contains task nodes; when a node completes, the system dispatches downstream nodes by dependency.")}
            </p>
            <div className="automations-run-list">
              {data.panelDiscussions.length === 0 ? (
                <EmptyState
                  body={tx("还没有用于多 Agent 决策的 Panel 讨论。", "No panel discussions have been recorded for multi-agent decisions yet.")}
                  eyebrow={tx("Panel 讨论", "Panel discussions")}
                  title={tx("暂无讨论记录", "No discussions yet")}
                  variant="warm"
                />
              ) : (
                data.panelDiscussions.map((discussion) => {
                  const statusLabel = PANEL_DISCUSSION_STATUS_LABELS[discussion.status];
                  return (
                    <div className="automations-run" key={discussion.id}>
                      <div className="automations-run__header">
                        <strong>{discussion.goal}</strong>
                        <span className={`automations-card__badge automations-card__badge--run-${statusLabel.badge}`}>
                          {tx(statusLabel.label, statusLabel.labelEn)}
                        </span>
                      </div>
                      <p>
                        {tx("参与 Agent", "Agents")}: {discussion.participantAgentIds.length > 0 ? discussion.participantAgentIds.join(", ") : tx("未指定", "Not specified")}
                        {` · ${tx("意见", "Opinions")}: ${discussion.opinionCount}`}
                      </p>
                      {discussion.latestOpinion ? (
                        <small>
                          {tx("最新意见", "Latest opinion")}: {discussion.latestOpinion.actorId} · {discussion.latestOpinion.stance} · {discussion.latestOpinion.body}
                        </small>
                      ) : null}
                      {discussion.decision ? (
                        <small>
                          {tx("最终决策", "Final decision")}: {discussion.decision.body}
                          {discussion.decision.decidedById ? ` · ${discussion.decision.decidedById}` : ""}
                        </small>
                      ) : null}
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(discussion.updatedAt, { emptyFallback: discussion.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
            <div className="automations-run-list">
              {data.collaborationRuns.length === 0 ? (
                <EmptyState
                  body={tx("还没有通过 Orchestrator API 创建的多 Agent 编排运行。", "No multi-agent orchestration runs have been created through the Orchestrator API yet.")}
                  eyebrow={tx("运行实例", "Runs")}
                  title={tx("暂无运行记录", "No runs yet")}
                  variant="warm"
                />
              ) : (
                data.collaborationRuns.map((run) => {
                  const statusLabel = COLLABORATION_RUN_STATUS_LABELS[run.status];
                  return (
                    <div className="automations-run" key={run.id}>
                      <div className="automations-run__header">
                        <strong>{run.title}</strong>
                        <span className={`automations-card__badge automations-card__badge--run-${statusLabel.badge}`}>
                          {tx(statusLabel.label, statusLabel.labelEn)}
                        </span>
                      </div>
                      <p>{run.goal}</p>
                      {run.evidenceSummary ? (
                        <p>
                          {tx("运行证据", "Run evidence")}: {run.evidenceSummary}
                          {run.evidenceNodeCount ? ` · ${tx("节点", "Nodes")}: ${run.evidenceNodeCount}` : ""}
                          {run.evidenceSourceCount ? ` · ${tx("证据", "Evidence")}: ${run.evidenceSourceCount}` : ""}
                        </p>
                      ) : null}
                      <div className="automations-card__flow">
                        {run.nodes.map((node, index) => {
                          const nodeStatus = COLLABORATION_NODE_STATUS_LABELS[node.status];
                          const reviewStatus = node.reviewStatus ? COLLABORATION_REVIEW_STATUS_LABELS[node.reviewStatus] : undefined;
                          return (
                            <span className="automations-card__action" key={node.id} title={node.instruction}>
                              {index + 1}. {node.title} · {node.agentId} · {tx(nodeStatus.label, nodeStatus.labelEn)}
                              {node.taskQueueId ? ` · ${tx("队列", "Queue")}: ${node.taskQueueId.slice(0, 12)}` : ""}
                              {reviewStatus ? ` · ${tx(reviewStatus.label, reviewStatus.labelEn)}` : ""}
                            </span>
                          );
                        })}
                      </div>
                      {run.nodes.some((node) => node.errorText || node.reviewStatus || node.evidenceSummary || node.resultSummary) ? (
                        <div className="automations-run-list">
                          {run.nodes
                            .filter((node) => node.errorText || node.reviewStatus || node.evidenceSummary || node.resultSummary)
                            .map((node) => {
                              const reviewLabel = node.reviewStatus ? COLLABORATION_REVIEW_STATUS_LABELS[node.reviewStatus] : undefined;
                              return (
                                <small key={`${node.id}:summary`}>
                                  {node.title}: {node.errorText ?? node.evidenceSummary ?? node.resultSummary ?? tx("暂无结果摘要", "No result summary")}
                                  {node.evidenceSourceCount ? ` · ${tx("证据", "Evidence")}: ${node.evidenceSourceCount}` : ""}
                                  {reviewLabel ? ` · ${tx("验收", "Review")}: ${tx(reviewLabel.label, reviewLabel.labelEn)}` : ""}
                                  {node.reviewComment ? ` · ${node.reviewComment}` : ""}
                                </small>
                              );
                            })}
                        </div>
                      ) : null}
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(run.updatedAt, { emptyFallback: run.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedBuiltinSafeCodeDevelopmentRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("安全并行开发", "Safe parallel development")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条入口用于查看多 Agent 代码开发会话。当前阶段只记录隔离 worktree、patch 摘要和审查状态，不会自动执行 git merge。", "This entry shows multi-agent code development sessions. This stage records isolated worktrees, patch summaries, and review state; it does not run git merge automatically.")}
            </p>
            <div className="automations-run-list">
              {data.codeDevelopmentSessions.length === 0 ? (
                <EmptyState
                  body={tx("还没有创建安全并行开发会话。", "No safe parallel development sessions have been created yet.")}
                  eyebrow={tx("开发会话", "Development sessions")}
                  title={tx("暂无开发记录", "No development sessions yet")}
                  variant="warm"
                />
              ) : (
                data.codeDevelopmentSessions.map((session) => {
                  const statusLabel = CODE_DEVELOPMENT_STATUS_LABELS[session.status];
                  return (
                    <div className="automations-run" key={session.id}>
                      <div className="automations-run__header">
                        <strong>{session.title}</strong>
                        <span className={`automations-card__badge automations-card__badge--run-${statusLabel.badge}`}>
                          {tx(statusLabel.label, statusLabel.labelEn)}
                        </span>
                      </div>
                      <p>{session.goal}</p>
                      <small>
                        {tx("Branch", "Branch")}: {session.branchName}
                        {session.baseRef ? ` · ${tx("Base", "Base")}: ${session.baseRef}` : ""}
                      </small>
                      <small>
                        {tx("Worktree", "Worktree")}: {session.worktreePath}
                      </small>
                      <small>
                        {tx("参与 Agent", "Agents")}: {session.assignedAgentIds.length > 0 ? session.assignedAgentIds.join(", ") : tx("未指定", "Not specified")}
                      </small>
                      {session.patchSummary ? (
                        <small>
                          {tx("Patch", "Patch")}: {session.patchSummary}
                          {session.changedFiles.length > 0 ? ` · ${tx("文件", "Files")}: ${session.changedFiles.join(", ")}` : ""}
                        </small>
                      ) : null}
                      {session.patchSha256 || session.patchBaseRef || session.patchHeadRef || session.patchSizeBytes !== undefined ? (
                        <small>
                          {tx("Manifest", "Manifest")}: {session.patchBaseRef ? `${tx("Base", "Base")} ${session.patchBaseRef}` : ""}
                          {session.patchHeadRef ? ` · ${tx("Head", "Head")} ${session.patchHeadRef}` : ""}
                          {session.patchSha256 ? ` · sha256 ${session.patchSha256.slice(0, 12)}` : ""}
                          {session.patchSizeBytes !== undefined ? ` · ${session.patchSizeBytes} bytes` : ""}
                        </small>
                      ) : null}
                      {session.reviewStatus ? (
                        <small>
                          {tx("审查", "Review")}: {session.reviewStatus}
                          {session.reviewComment ? ` · ${session.reviewComment}` : ""}
                        </small>
                      ) : null}
                      {session.preflightStatus ? (
                        <small>
                          {tx("预检", "Preflight")}: {session.preflightStatus}
                          {session.preflightTargetBranch ? ` · ${tx("Target", "Target")}: ${session.preflightTargetBranch}` : ""}
                          {session.preflightConflictFiles.length > 0 ? ` · ${tx("冲突", "Conflicts")}: ${session.preflightConflictFiles.join(", ")}` : ""}
                          {session.preflightWarnings.length > 0 ? ` · ${tx("警告", "Warnings")}: ${session.preflightWarnings.join(" · ")}` : ""}
                          {session.preflightRecommendation ? ` · ${session.preflightRecommendation}` : ""}
                        </small>
                      ) : null}
                      {session.riskNotes.length > 0 ? (
                        <small>{tx("风险", "Risks")}: {session.riskNotes.join(" · ")}</small>
                      ) : null}
                      {session.mergeNotes ? <small>{tx("合并备注", "Merge notes")}: {session.mergeNotes}</small> : null}
                      {session.blockedReason ? <small>{tx("阻塞原因", "Blocked reason")}: {session.blockedReason}</small> : null}
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(session.updatedAt, { emptyFallback: session.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{selectedRule.name}</h2>
              <span>{selectedRule.enabled ? tx("启用", "Enabled") : tx("停用", "Paused")}</span>
            </div>
            {selectedRule.description ? <p>{selectedRule.description}</p> : null}
            <div className="automations-card__flow">
              <span className="automations-card__trigger">
                {TRIGGER_TYPES.find((item) => item.value === selectedRule.trigger.type)?.label ?? selectedRule.trigger.type}
              </span>
              {selectedRule.conditions.map((condition) => (
                <span className="automations-card__conditions" key={`${condition.field}:${condition.operator}:${condition.value}`}>
                  → {getConditionFieldLabel(condition.field, tx)} {getConditionOperatorLabel(condition.operator, tx)} {condition.value}
                </span>
              ))}
              <span className="automations-card__arrow">→</span>
              {selectedRule.actions.map((action, index) => (
                <span className="automations-card__action" key={`${action.type}:${index}`}>
                  {ACTION_TYPES.find((item) => item.value === action.type)?.label ?? action.type}
                </span>
              ))}
            </div>
            <div className="automations-card__meta">
              {tx("执行次数", "Runs")}: {selectedRule.runCount}
              {selectedRule.lastTriggeredAt
                ? ` · ${tx("最近触发", "Last run")}: ${formatCompactTimestamp(selectedRule.lastTriggeredAt, { emptyFallback: selectedRule.lastTriggeredAt })}`
                : ""}
            </div>
          </div>
        ) : null}

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal knowledge-modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="automations-builder__header">
              <div>
                <span>{tx("自定义规则", "Custom rule")}</span>
                <h3>{tx("新建自动化规则", "New automation rule")}</h3>
              </div>
            </div>

            <div className="automations-builder__identity">
              <input
                autoFocus
                className="knowledge-modal__input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={tx("给这条规则起个名字", "Name this rule")}
              />
              <input
                className="knowledge-modal__input"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder={tx("备注，例如：客户投诉自动通知", "Note, for example: notify on customer complaints")}
              />
            </div>

            <div className="automations-builder">
              <div className="automations-builder__step">
                <span className="automations-builder__step-index">1</span>
                <div className="automations-builder__step-body">
                  <label>{tx("当发生", "When")}</label>
                  <select
                    className="tables-create__col-type"
                    value={createTriggerType}
                    onChange={(e) => setCreateTriggerType(e.target.value as AutomationTriggerType)}
                  >
                    {TRIGGER_TYPES.map((trigger) => (
                      <option key={trigger.value} value={trigger.value}>
                        {tx(trigger.label, trigger.labelEn)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="automations-builder__step">
                <span className="automations-builder__step-index">2</span>
                <div className="automations-builder__step-body">
                  <label>{tx("如果满足", "If")}</label>
                  <div className="automations-builder__condition">
                    <select
                      className="tables-create__col-type"
                      value={createConditionField}
                      onChange={(e) => setCreateConditionField(e.target.value)}
                    >
                      {CONDITION_FIELDS.map((field) => (
                        <option key={field.value} value={field.value}>
                          {tx(field.label, field.labelEn)}
                        </option>
                      ))}
                    </select>
                    <select
                      className="tables-create__col-type"
                      value={createConditionOperator}
                      onChange={(e) => setCreateConditionOperator(e.target.value as AutomationConditionOperator)}
                    >
                      {CONDITION_OPERATORS.map((operator) => (
                        <option key={operator.value} value={operator.value}>
                          {tx(operator.label, operator.labelEn)}
                        </option>
                      ))}
                    </select>
                    <input
                      className="knowledge-modal__input"
                      value={createConditionValue}
                      onChange={(e) => setCreateConditionValue(e.target.value)}
                      placeholder={tx(selectedConditionField.placeholder, selectedConditionField.placeholderEn)}
                    />
                  </div>
                </div>
              </div>

              <div className="automations-builder__step">
                <span className="automations-builder__step-index">3</span>
                <div className="automations-builder__step-body">
                  <label>{tx("就执行", "Then")}</label>
                  <select
                    className="tables-create__col-type"
                    value={createActionType}
                    onChange={(e) => setCreateActionType(e.target.value as AutomationActionType)}
                  >
                    {ACTION_TYPES.map((action) => (
                      <option key={action.value} value={action.value}>
                        {tx(action.label, action.labelEn)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="automations-builder__preview">
              <span>{tx("规则预览", "Preview")}</span>
              <strong>
                {tx("当", "When")} {tx(selectedTriggerLabel?.label ?? createTriggerType, selectedTriggerLabel?.labelEn ?? createTriggerType)}
                {createConditionValue.trim()
                  ? `，${tx("且", "and")} ${tx(selectedConditionField.label, selectedConditionField.labelEn)} ${tx(selectedOperatorLabel?.label ?? createConditionOperator, selectedOperatorLabel?.labelEn ?? createConditionOperator)} “${createConditionValue.trim()}”`
                  : `，${tx("无额外条件", "with no extra condition")}`}
                ，{tx("执行", "run")} {tx(selectedActionLabel?.label ?? createActionType, selectedActionLabel?.labelEn ?? createActionType)}
              </strong>
            </div>

            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createName.trim()}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}
