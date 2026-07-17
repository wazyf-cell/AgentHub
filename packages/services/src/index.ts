// State I/O
export {
  getWorkspaceStateFilePath,
  getWorkspaceDatabaseFilePath,
  getWorkspaceAttachmentsDirPath,
  ensureWorkspaceStateSync,
  readWorkspaceStateSnapshotSync,
  readWorkspaceStateSync,
  writeWorkspaceStateSync,
  resetWorkspaceStateSync,
} from "./shared/state-io.ts";
export {
  recordWorkspaceAuditEventSync,
  tryRecordWorkspaceAuditEventSync,
} from "./shared/audit.ts";
export {
  archiveNotificationSync,
  countUnreadNotificationsSync,
  createNotificationSync,
  createNotificationsSync,
  listNotificationsForRecipientSync,
  markNotificationReadSync,
  postNotificationChannelMessageSync,
  type CreateWorkspaceNotificationInput,
  type WorkspaceNotificationRecipient,
  type WorkspaceNotificationRecipientType,
  type WorkspaceNotificationRecord,
  type WorkspaceNotificationStatus,
} from "./notifications/notifications.ts";
export {
  buildConversationExecutionWorkspaceKey,
  readConversationExecutionWorkspaceState,
  resolveConversationExecutionWorkspacePath,
  upsertConversationExecutionWorkspaceState,
  writeConversationExecutionWorkspaceStateSync,
} from "./shared/conversation-execution-workspaces.ts";
// Workspace
export {
  bootstrapWorkspaceSync,
  initializeOrganizationSync,
  addHumanMemberSync,
  readWorkspaceSnapshotSync,
  readWorkspaceSummarySync,
} from "./workspace/workspace.ts";

// Employees
export {
  listActiveEmployeesSync,
  listEmployeeSkillIdsMapSync,
  listEmployeeSkillIdsSync,
  listEmployeeRuntimeBindingsForWorkspaceSync,
  bindEmployeeExecutionSync,
  bindEmployeeRuntimeSync,
  unbindEmployeeRuntimeSync,
  deleteEmployeeSync,
  updateEmployeeInstructionsSync,
  updateEmployeeRemarkNameSync,
  setEmployeeChannelMemberAccessSync,
  createEmployeeSync,
  buildLegacyAgentIdForEmployeeName,
  setEmployeeSkillIdsSync,
  listEmployeeSkillIdsByAgentIdMapSync,
} from "./employees/employees.ts";

// Runtime access
export {
  assertCanManageEmployeeForActorSync,
  assertCanManageRuntimeGrantsSync,
  assertCanUseBoundEmployeeRuntimeInChannelForActorSync,
  assertCanUseBoundEmployeeRuntimeForActorSync,
  assertCanUseEmployeeInChannelForActorSync,
  assertCanUseEmployeeForActorSync,
  assertCanUseEmployeeRuntimeInChannelForActorSync,
  assertCanUseEmployeeRuntimeForActorSync,
  assertCanUseRuntimeForActorSync,
  canUseEmployeeInChannelForActorSync,
  canManageEmployeeForActorSync,
  canManageRuntimeGrantsSync,
  canUseEmployeeForActorSync,
  canUseEmployeeRuntimeInChannelForActorSync,
  canUseEmployeeRuntimeForActorSync,
  canUseRuntimeForActorSync,
  grantRuntimeUseToUserForActorSync,
  isWorkspaceAdminOrOwnerSync,
  listRuntimeGrantsForActorSync,
  revokeRuntimeUseFromUserForActorSync,
  type RuntimeAccessActor,
} from "./runtime-access/runtime-access.ts";
export {
  normalizeRuntimeProviderHealth,
  type NormalizeRuntimeProviderHealthInput,
} from "./runtime-health/runtime-health.ts";
export {
  acceptAgentForkInvitationForActorSync,
  createAgentForkInvitationForActorSync,
  listAgentForkInvitationsForActorSync,
  listAgentForkInvitationsForSourceAgentSync,
  revokeAgentForkInvitationForActorSync,
  type AgentForkInvitationRecord,
  type AgentForkOptions,
  type AgentForkSnapshot,
} from "./agent-forks/agent-forks.ts";
export {
  approveAgentAccessRequestForActorSync,
  cancelAgentAccessRequestForActorSync,
  canDecideAgentAccessRequest,
  createAgentAccessRequestForActorSync,
  listAgentAccessRequestsForActorSync,
  rejectAgentAccessRequestForActorSync,
  type AgentAccessRequestRecord,
  type AgentAccessRequestStatus,
  type AgentAccessRequestType,
} from "./agent-access-requests/agent-access-requests.ts";
export {
  CLIHUB_HARNESS_REGISTRY_URL,
  CLIHUB_PUBLIC_REGISTRY_FALLBACK_URL,
  CLIHUB_PUBLIC_REGISTRY_URL,
  listCliHubCatalogItems,
  normalizeCliHubRegistryPayload,
  readCliHubCatalogHealth,
  readCliHubCatalogItem,
  syncCliHubCatalog,
  type CliHubCatalogSyncResult,
} from "./clihub/catalog.ts";
export {
  assessRuntimeAppRisk,
  buildRuntimeAppInstallPlan,
} from "./clihub/install-plan.ts";
export {
  assertCanManageRuntimeAppsSync,
  listRuntimeAppContextEntriesForRuntimeSync,
  listRuntimeAppOperationsForRuntimeSync,
  listRuntimeAppsForRuntimeSync,
  normalizeCliHubReadiness,
  readCliHubReadinessForRuntimeSync,
  readCliHubReadinessFromRuntimeMetadata,
  readRuntimeAppAvailabilityForSkillSync,
  requestRuntimeAppOperationSync,
  type CliHubReadinessView,
  type RuntimeAppOperationRequestResult,
} from "./clihub/runtime-apps.ts";
export {
  syncRuntimeAppSkill,
  type RuntimeAppSkillSyncResult,
} from "./clihub/skill-sync.ts";

// Skills
export {
  BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME,
  BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME,
  BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME,
  BUILTIN_GOOGLE_WORKSPACE_CLI_SKILL_NAME,
  listWorkspaceSkillsSync,
  readWorkspaceSkillSync,
  createWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  deleteWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
  deleteWorkspaceSkillFileSync,
  isBuiltinSkill,
  isSystemSkillName,
} from "./skills/skills.ts";
export {
  materializeWorkspaceSkillsForProvider,
  type MaterializedSkillDirectories,
} from "./skills/injection.ts";
export {
  exportWorkspaceSkillsArchiveSync,
  type ExportedSkillsArchive,
  type SkillExportManifestEntry,
} from "./skills/export.ts";
export {
  importWorkspaceSkillFromUrl,
  type SkillImportConflict,
  type SkillImportResult,
} from "./skills/import.ts";
export {
  resolveSystemAgentTemplateForWorkspaceSync,
  type ResolvedAgentTemplateForWorkspace,
} from "./agent-templates/agent-templates.ts";

// Channels
export {
  addChannelEmployeesSync,
  createChannelSync,
  deleteChannelSync,
  renameChannelSync,
  updateChannelHumanMemberNamesSync,
  ensureDirectChannelSync,
  resolveCompatibleDirectChannelRecord,
  resolveChannelHumanMemberNames,
  resolveChannelHumanMemberCount,
} from "./channels/channels.ts";

export {
  addWorkspaceMemberToChannelForActorSync,
  acceptChannelInvitationForActorSync,
  approveChannelAccessRequestForActorSync,
  assertCanReadChannelForActorSync,
  assertCanWriteChannelForActorSync,
  canReadDirectChannelForActorSync,
  canReadChannelForActorSync,
  canWriteChannelForActorSync,
  createChannelParticipantsForMembersSync,
  getChannelAccessSummaryForActorSync,
  inviteUserToChannelForActorSync,
  listChannelAccessRequestsForManagerSync,
  listChannelInvitationsForActorSync,
  rejectChannelInvitationForActorSync,
  rejectChannelAccessRequestForActorSync,
  removeWorkspaceMemberFromChannelForActorSync,
  requestChannelAccessForActorSync,
  revokeChannelInvitationForActorSync,
  type ChannelAccessActor,
  type ChannelAccessState,
  type ChannelAccessSummary,
} from "./channel-access/channel-access.ts";

// Contacts
export {
  postHumanDirectSystemMessageSync,
  resolveHumanDirectChannelForUsersSync,
  sendContactMessageSync,
  sendContactMessageWithAttachmentsSync,
  sendContactMessageForHumanWithAttachmentsSync,
  sendHumanDirectMessageSync,
  upsertDirectConversationStateSync,
} from "./contacts/contacts.ts";

// Messages
export {
  completeAgentChannelReplySync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  parseChannelMentionsSync,
  postMessageSync,
  sendChannelHumanMessageSync,
  replacePendingChannelMessageSync,
  pinMessageSync,
  unpinMessageSync,
  acknowledgeMessageSync,
} from "./messages/messages.ts";

// Realtime
export {
  publishChannelMessageCreatedEvent,
  publishChannelThreadChangedEvent,
  subscribeWorkspaceRealtimeEvents,
  type WorkspaceRealtimeEvent,
  type WorkspaceRealtimeListener,
} from "./realtime/events.ts";

// Tasks
export {
  listTasksSync,
  createTaskSync,
  updateTaskStatusSync,
  reorderTaskSync,
  addTaskLabelSync,
  removeTaskLabelSync,
} from "./tasks/tasks.ts";

export {
  recordTaskExecutionEventSync,
  listTaskExecutionEventsSync,
  type TaskExecutionEventInput,
  type TaskExecutionEventListOptions,
  type TaskExecutionEventRecord,
} from "./task-execution-events.ts";

// Approvals
export {
  listApprovalsSync,
  createApprovalRequestSync,
  createRuntimeToolApprovalRequestSync,
  reviewApprovalSync,
} from "./approvals/approvals.ts";

// Collaboration
export {
  resolveCollaborativeObjectSync,
  type CollaborativeObjectInput,
} from "./collaboration/registry.ts";
export {
  listCollaborationActivitiesSync,
  recordCollaborationActivitySync,
  type CollaborationObjectFilter,
} from "./collaboration/activity.ts";
export {
  createCollaborationCommentThreadSync,
  addCollaborationCommentSync,
  listCollaborationCommentThreadsSync,
} from "./collaboration/comments.ts";
export {
  createPanelDiscussionSync,
  listPanelDiscussionsSync,
  recordPanelDecisionSync,
  recordPanelOpinionSync,
  type CreatePanelDiscussionInput,
  type PanelDiscussionDecisionRecord,
  type PanelDiscussionOpinionRecord,
  type PanelDiscussionRecord,
  type PanelDiscussionStatus,
  type PanelOpinionStance,
  type RecordPanelDecisionInput,
  type RecordPanelOpinionInput,
} from "./collaboration/panel.ts";
export {
  acceptCollaborationChangeProposalSync,
  createCollaborationChangeProposalSync,
  listCollaborationChangeProposalsSync,
  rejectCollaborationChangeProposalSync,
} from "./collaboration/proposals.ts";
export {
  approveCollaborationPlanSync,
  completeCollaborationNodeAndDispatchNextSync,
  completeQueuedTaskAndAdvanceCollaborationSync,
  createAndDispatchCollaborationRunSync,
  createCollaborationPlanDraftSync,
  dispatchReadyCollaborationNodesSync,
  failQueuedTaskAndAdvanceCollaborationSync,
  reviewCollaborationNodeSync,
  type ApproveCollaborationPlanInput,
  type ApproveCollaborationPlanResult,
  type CollaborationDispatchPriority,
  type CollaborationPlanResult,
  type CollaborationSynthesisNodeInput,
  type CompleteCollaborationNodeAndDispatchNextInput,
  type CompleteCollaborationNodeAndDispatchNextResult,
  type CompleteQueuedTaskAndAdvanceCollaborationInput,
  type CreateAndDispatchCollaborationRunInput,
  type CreateAndDispatchCollaborationRunResult,
  type CreateCollaborationPlanDraftInput,
  type DispatchReadyCollaborationNodesInput,
  type DispatchReadyCollaborationNodesResult,
  type DispatchedCollaborationNode,
  type FailQueuedTaskAndAdvanceCollaborationInput,
  type QueuedTaskCollaborationAdvanceResult,
  type ReviewCollaborationNodeInput,
  type ReviewCollaborationNodeResult,
  type SkippedCollaborationNode,
} from "./orchestrator/orchestrator.ts";

// Materials
export {
  listMaterialsSync,
  addMaterialSync,
  importMaterialFileSync,
  parseMaterialSync,
} from "./materials/materials.ts";

// Knowledge
export {
  listKnowledgePagesSync,
  readKnowledgePageSync,
  createKnowledgePageSync,
  createKnowledgePageFromSharedDocumentSync,
  updateKnowledgePageSync,
  moveKnowledgePageSync,
  deleteKnowledgePageSync,
  materialToKnowledgePageSync,
} from "./knowledge/knowledge.ts";
export {
  approveKnowledgeProposalForActorSync,
  createKnowledgeProposalFromAgentSync,
  listKnowledgeProposalsForWorkspaceSync,
  listPendingKnowledgeProposalsForApproverSync,
  readKnowledgeProposalSync,
  rejectKnowledgeProposalForActorSync,
  type ApproveKnowledgeProposalInput,
  type CreateKnowledgeProposalFromAgentInput,
  type KnowledgeProposalApprovalResult,
  type KnowledgeProposalOperation,
  type RejectKnowledgeProposalInput,
} from "./knowledge-proposals/knowledge-proposals.ts";
export {
  listKnowledgeAssignmentPoliciesSync,
  listKnowledgeAssignmentsSync,
  listKnowledgeAssignmentsByPageIdSync,
  listKnowledgeAssignmentsByEmployeeSync,
  listEmployeeKnowledgePageIdsSync,
  listEmployeeKnowledgePagesSync,
  setKnowledgePageAssignmentModeSync,
  setKnowledgePageAssignedEmployeesSync,
  setEmployeeKnowledgePageIdsSync,
  deleteKnowledgeAssignmentsForPageSync,
  deleteKnowledgeAssignmentsForEmployeeSync,
  type AgentKnowledgePageAssignment,
  type KnowledgeAssignmentPolicy,
} from "./knowledge/assignments.ts";

// Attachments
export {
  deleteChannelAttachmentSync,
  deleteWorkspaceAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  persistWorkspaceAttachmentFromFileSync,
  pruneOrphanWorkspaceAttachmentsSync,
  type DeleteChannelAttachmentResult,
} from "./attachments/attachments.ts";
export {
  createAttachmentStorageClient,
  type AttachmentStorageReadInput,
  type AttachmentStorageObjectMetadata,
  type AttachmentStoragePutInput,
  type StoredAttachmentObject,
} from "./attachments/storage.ts";
export {
  readStoredAttachmentSync,
} from "@agent-space/db";
export {
  resolveAgentSpaceRuntimeConfig,
  resolveAttachmentRuntimeConfig,
  type AgentSpaceRuntimeConfig,
  type AttachmentRuntimeConfig,
} from "./config/deployment.ts";
export {
  resolveAttachmentMediaType,
  inferAttachmentKind,
  sameValue,
} from "./shared/helpers.ts";

// Search
export {
  globalSearchSync,
  type SearchResult,
  type SearchResultType,
  type SearchOptions,
} from "./search/search.ts";

// Context
export {
  buildContactAgentContext,
  buildContactAgentContextSync,
  type ContactAgentContext,
  type ContactContextEntity,
} from "./context/provider.ts";
export {
  listWorkspaceContextChannels,
  listWorkspaceContextChannelsSync,
  listWorkspaceContextDocuments,
  listWorkspaceContextDocumentsSync,
  listWorkspaceContextEntities,
  listWorkspaceContextEntitiesSync,
  resolveWorkspaceContextEntity,
  resolveWorkspaceContextEntitySync,
  searchWorkspaceContextMessages,
  searchWorkspaceContextMessagesSync,
  type WorkspaceContextChannelSummary,
  type WorkspaceContextMessageResult,
} from "./context/query.ts";

// Costs
export {
  getCostDashboardDataSync,
  getAgentCostProfileSync,
  type AgentCostProfile,
  type CostDashboardData,
} from "./costs/costs.ts";

// Budgets
export {
  checkBudgetSync,
  checkAllBudgetsForAgentSync,
  listBudgetsWithSpentSync,
  upsertBudgetSync,
  toggleBudgetSync,
  deleteBudgetSync,
  type BudgetCheckResult,
  type BudgetWithSpent,
} from "./budgets/budgets.ts";

// Performance
export {
  getPerformanceDashboardDataSync,
  type AgentPerformanceMetrics,
  type PerformanceDashboardData,
} from "./performance/performance.ts";

// Estimation
export {
  estimateTaskSync,
  type EstimationInput,
  type AgentEstimation,
  type TaskEstimationResult,
} from "./estimation/estimator.ts";

// Tables
export {
  listDataTablesSync,
  readDataTableSync,
  createDataTableSync,
  updateDataTableSync,
  deleteDataTableSync,
  addDataRowSync,
  updateDataRowSync,
  deleteDataRowSync,
} from "./tables/tables.ts";

// Automations
export {
  listAutomationRulesSync,
  readAutomationRuleSync,
  createAutomationRuleSync,
  updateAutomationRuleSync,
  toggleAutomationRuleSync,
  deleteAutomationRuleSync,
} from "./automations/automations.ts";
export {
  AUTO_CONTINUATION_REPLY,
  continueAutoContinuationAfterTaskSync,
  createAutoContinuationState,
  parseAutoContinuationDirective,
  stopAutoContinuationSync,
  type AutoContinuationDirective,
  type AutoContinuationDispatchResult,
  type StopAutoContinuationResult,
} from "./automations/auto-continuation.ts";

// Schedules
export {
  listScheduledTasksSync,
  readScheduledTaskSync,
  createScheduledTaskSync,
  updateScheduledTaskSync,
  toggleScheduledTaskSync,
  deleteScheduledTaskSync,
} from "./schedules/schedules.ts";

// Permissions
export {
  getWorkspacePermissionCenterSync,
  getWorkspacePermissionTreeSync,
  getWorkspaceActorPermissionSummarySync,
  getPermissionDiagnosticsSync,
  type PermissionActorSummary,
  type PermissionBinding,
  type PermissionCatalogAgent,
  type PermissionCatalogKnowledgePage,
  type PermissionCatalogMember,
  type PermissionCatalogSkill,
  type PermissionCenterActorInput,
  type PermissionCenterData,
  type PermissionDiagnostic,
  type PermissionResourceType,
  type PermissionSource,
  type PermissionSubjectType,
  type PermissionTreeNode,
} from "./permissions/permissions.ts";

// Document permissions
export {
  AgentDocumentPermissionError,
  approveDocumentPermissionRequestSync,
  assertAgentDocumentActionAllowedSync,
  cancelDocumentPermissionRequestSync,
  createDocumentPermissionRequestSync,
  grantDocumentAgentAccessSync,
  listDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync,
  listPendingDocumentPermissionRequestsSync,
  rejectDocumentPermissionRequestSync,
  resolveAgentDocumentContextSync,
  resolveAgentDocumentRejectionContextSync,
  revokeDocumentAgentAccessSync,
  type AgentDocumentContext,
  type DocumentAgentAccessRecord,
  type DocumentPermissionRequestExternalProvider,
  type DocumentPermissionRequestRecord,
} from "./document-permissions/document-permissions.ts";

// Templates
export {
  listTemplatesSync,
  readTemplateSync,
  createTemplateSync,
  updateTemplateSync,
  deleteTemplateSync,
} from "./templates/templates.ts";

// Documents
export {
  listChannelDocumentsSync,
  listChannelDocumentVersionsSync,
  listChannelDocumentBlocksSync,
  listChannelDocumentAccessesSync,
  readChannelDocumentSync,
  canViewChannelDocumentSync,
  upsertChannelDocumentPresenceSync,
  clearChannelDocumentPresenceSync,
  createChannelDocumentSync,
  createExternalGoogleSheetChannelDocumentSync,
  createExternalGoogleDocChannelDocumentSync,
  updateExternalChannelDocumentMetadataSync,
  updateChannelDocumentSync,
  recordExternalSheetOperationRunSync,
  updateExternalSheetOperationRunSync,
  renameChannelDocumentSync,
  archiveChannelDocumentSync,
  restoreChannelDocumentSync,
  rollbackChannelDocumentVersionSync,
  exportChannelDocumentAsAttachmentSync,
  createChannelDocumentFromAttachmentSync,
  listChannelMarkdownAttachmentsSync,
  addChannelDocumentCollaboratorSync,
  removeChannelDocumentCollaboratorSync,
  updateChannelDocumentAccessRoleSync,
  recordChannelDocumentConflictSync,
  resolveChannelDocumentConflictSync,
  retryChannelDocumentConflictSync,
  markChannelDocumentRunStepRunningSync,
  completeChannelDocumentRunStepSync,
  failChannelDocumentRunStepSync,
} from "./documents/sync.ts";
export {
  applyChannelDocumentBlockOperations,
  type ChannelDocumentOperation,
} from "./documents/operations.ts";
