export {
  BoardDefinitionError,
  codeBoardOf,
  compileBoardDefinition,
  declarationOf,
  DEFAULT_PHASE_CONTEXT,
  defineBoard,
  FACTORY_AGENT_ID,
  FACTORY_PHASE_TOOLS,
  isDefinedBoard,
  REVIEW_CONTEXT,
} from './boards/define-board.ts';
export { DEFAULT_BOARD_ID } from './boards/default-board.ts';
export type { AnyBoardConfig } from './boards/define-board.ts';
export { cardRuleFacts } from './boards/card-facts.ts';
export {
  closedIssueRuleFacts,
  INTAKE_ROUTE_METADATA_KEY,
  intakeTargetProblem,
  landingPhase,
  placedByIntakeRoute,
  placesNewCards,
  resolveEventRoute,
  resolveIntakePlacement,
  resolveIntakeRoute,
  routesHandleEvent,
} from './boards/intake-routing.ts';
export type {
  IntakeRoute,
  IntakeRouteResolution,
  IntakeRoutesReader,
  IntakeTargetProblem,
} from './boards/intake-routing.ts';
export { holdsLegacyPlanner, LEGACY_PLAN_ROLE, legacyPlanRoleFor } from './boards/legacy-plan-role.ts';
export {
  autoApprovedExitTool,
  exitToolSucceeded,
  PHASE_EXIT_METADATA_KEY,
  startsInAutoPhase,
} from './boards/phase-automation.ts';
export { phaseRunDecision } from './boards/phase-runner.ts';
export type { PhaseEntry } from './boards/phase-runner.ts';
export type {
  BoardDefinition,
  BoardEventIntegration,
  BoardEventRules,
  BoardPhase,
  BoardPhaseDefinition,
  BoardPhaseExitTool,
  BoardPhaseGoal,
  BoardPhaseKind,
  BoardPhaseRunner,
  BoardSourceClosed,
  FactoryPhaseTool,
  BoardToolResultRuleHandler,
  BoardToolRule,
  BoardToolRules,
  BoardTransition,
} from './boards/define-board.ts';
export { createBoardRegistry } from './boards/registry.ts';
export { PROJECT_BOARD_SOURCE, toBoardSource } from './boards/project-board-source.ts';
export type {
  BoardScope,
  BoardSourceKind,
  ProjectBoards,
  ProjectBoardSource,
  StoredBoardDetails,
} from './boards/project-board-source.ts';
export type { BoardRegistry, InstalledBoard } from './boards/registry.ts';
export { cardLabels, moveCardToBoard } from './boards/relocate.ts';
export {
  awaitsAcceptance,
  boardClassifiesTriage,
  boardEventHandlers,
  boardFlow,
  boardForWorkItem,
  boardPhaseOutcomes,
  cardBoardFlow,
  intakeTarget,
  isPullRequestReviewPhase,
  pullRequestCardRejection,
  withBoardFlow,
  withIntakeTarget,
  boundChangeRequestNumber,
  hasPullRequest,
  isPullRequestCard,
  newestOpenPullRequestNumber,
  openSource as isOpenPullRequestSource,
  pullRequestSourceNumber,
  pullRequestSources,
  hasRecordedVerdict,
  reviewedChangeRequest,
  reviewedPullRequest,
  sourceExternalId,
  reviewsPullRequest,
  eventBoardId,
  isTerminalWorkItem,
  resolveBoardClosure,
  resolveBoardToolRule,
  resolvePhaseSemantics,
  rulePhaseContext,
  rulePhaseField,
  withBoardClosure,
  workItemPhaseSemantics,
} from './boards/semantics.ts';
export type { MetricsPhaseOutcome, MetricsPhaseOutcomes, PhaseSemantics, ReviewedChangeRequest } from './boards/semantics.ts';
export { boardTransitionPolicyResultSchema, immutablePolicySnapshot } from './boards/transition-policy.ts';
export type {
  BoardTransitionPolicy,
  BoardTransitionPolicyContext,
  BoardTransitionPolicyResult,
} from './boards/transition-policy.ts';
export { WorkItemUpdateConflictError } from './card.ts';
export type {
  CardMoveStore,
  ExternalWorkItemSource,
  PipelineCard,
  ProviderWorkItem,
  WorkItemProvider,
  WorkItemSourceRow,
} from './card.ts';
export {
  closedByRoutes,
  composeEventRule,
  deploymentOwnsEvent,
  hasExplicitRuleOverride,
  isStatusEventDecision,
  recordExplicitRuleOverrides,
  routeEventDecision,
  selectEventRule,
  withoutRouteEvent,
} from './rules/event-rules.ts';
export { cardRuleGroupSchema, evaluateRuleGroup, RULE_OPERATORS, ruleGroupSchema } from './rules/rule-group.ts';
export type { RuleCondition, RuleFacts, RuleGroup, RuleOperator } from './rules/rule-group.ts';
export {
  AUTO_TRIAGED_LABEL,
  authorTrusted,
  externallyAuthored,
  externallyAuthoredWorkItem,
  SELF_REVIEW_ROUND_LIMIT,
  externalSourceForWorkItem,
  FACTORY_GITHUB_EVENTS,
  FACTORY_GITLAB_EVENTS,
  FACTORY_RULE_REJECTION_CODES,
  FACTORY_RULE_SOURCES,
  FACTORY_TRIAGE_TYPES,
  factoryRuleSourceForWorkItem,
  factoryRuleStage,
  isFactoryTriageType,
  needsApproval,
  NEEDS_APPROVAL_LABEL,
  WORK_ITEM_SOURCES,
  workItemSource,
} from './rules/types.ts';
export type {
  FactoryBoundRuleContext,
  FactoryCommitDecision,
  FactoryDismissStaleReviewsDecision,
  FactoryGithubEventName,
  FactoryGithubRuleContext,
  FactoryPullRequestHome,
  FactoryGitLabEventName,
  FactoryGitLabRuleContext,
  FactoryInvokeSkillDecision,
  FactoryNotifyDecision,
  FactoryRuleActor,
  FactoryRuleBoard,
  FactoryRuleBoardClosure,
  FactoryRuleBoardFlow,
  FactoryRuleIntakeTarget,
  FactoryRuleCausalEntry,
  FactoryRuleContextBase,
  FactoryRuleDecision,
  FactoryRuleHandler,
  FactoryRuleIngressIdentity,
  FactoryRuleItemContext,
  FactoryRuleJsonValue,
  FactoryRulePhaseContext,
  FactoryRuleRejectionCode,
  FactoryRuleRejectDecision,
  FactoryRuleSource,
  FactoryRuleStage,
  FactorySendMessageDecision,
  FactoryStageRuleContext,
  FactoryToolResultRuleContext,
  FactoryRouteEventDecision,
  FactorySignalActivityDecision,
  FactoryTransitionDecision,
  FactoryTransitionResult,
  FactoryTransitionResultAccepted,
  FactoryTransitionResultRejected,
  FactoryTriageType,
  FactoryUpsertLinkedWorkItemDecision,
  WorkItemSource,
} from './rules/types.ts';
export {
  assertFactoryConfigVersion,
  assertFactoryDecisionTarget,
  DEFAULT_FACTORY_CONFIG_VERSION,
  FactoryRuleValidationError,
  IDENTIFIER_RE,
  isBoardIdentifier,
  isIdentifier,
  MAX_BOARD_IDENTIFIER_LENGTH,
  MAX_FACTORY_RULE_CAUSAL_DEPTH,
  MAX_ROLE_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  normalizeFactoryRuleJsonValue,
  validateFactoryRuleDecision,
  validateFactoryRuleDecisions,
} from './rules/validation.ts';
export {
  changeRequestOpenedPatch,
  changeRequestSettledPatch,
  describeChangeRequests,
  hasOpenChangeRequest,
  isOpenChangeRequest,
  namesRepository,
  openChangeRequests,
  ownsChangeRequest,
} from './change-requests.ts';
export type { OpenChangeRequest } from './change-requests.ts';
export type {
  FactoryReviewStatusEvent,
  FactoryReviewStatusPhase,
  FactoryReviewStatusReporter,
} from './rules/review-status.ts';
export * from './boards/board-events.ts';
