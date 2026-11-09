export {
  BoardDefinitionError,
  codeBoardOf,
  compileBoardDefinition,
  declarationOf,
  DEFAULT_PHASE_CONTEXT,
  defineBoard,
  FACTORY_AGENT_ID,
  isDefinedBoard,
} from './boards/define-board.ts';
export type { AnyBoardConfig } from './boards/define-board.ts';
export { cardRuleFacts } from './boards/card-facts.ts';
export {
  INTAKE_ROUTE_METADATA_KEY,
  intakeTargetProblem,
  landingPhase,
  placedByIntakeRoute,
  placesNewCards,
  resolveEventRoute,
  resolveIntakePlacement,
  routesHandleEvent,
} from './boards/intake-routing.ts';
export type { IntakeRoute, IntakeRoutesReader, IntakeTargetProblem } from './boards/intake-routing.ts';
export { holdsLegacyPlanner, LEGACY_PLAN_ROLE, legacyPlanRoleFor } from './boards/legacy-plan-role.ts';
export { autoApprovedExitTool, startsInAutoPhase } from './boards/phase-automation.ts';
export type {
  BoardChangeRequests,
  BoardDefinition,
  BoardEventIntegration,
  BoardEventRules,
  BoardPhase,
  BoardPhaseDefinition,
  BoardPhaseExitTool,
  BoardPhaseKind,
  BoardPhaseRunner,
  BoardSourceClosed,
  BoardToolResultRuleHandler,
  BoardToolRule,
  BoardToolRules,
  BoardTransition,
} from './boards/define-board.ts';
export { createBoardRegistry } from './boards/registry.ts';
export type { BoardRegistry, InstalledBoard } from './boards/registry.ts';
export { cardLabels, moveCardToBoard } from './boards/relocate.ts';
export {
  boardClassifiesTriage,
  boardEventHandlers,
  boardForWorkItem,
  isPullRequestCard,
  pullRequestReviewPhase,
  reviewsPullRequest,
  eventBoardId,
  isTerminalWorkItem,
  resolveBoardChangeRequests,
  resolveBoardClosure,
  resolveBoardToolRule,
  resolvePhaseSemantics,
  rulePhaseContext,
  rulePhaseField,
  withBoardClosure,
  withChangeRequests,
  workItemPhaseSemantics,
} from './boards/semantics.ts';
export type { PhaseSemantics } from './boards/semantics.ts';
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
export { resolveFactoryStageRules } from './rules/resolve.ts';
export type { ResolvedFactoryStageRule } from './rules/resolve.ts';
export {
  AUTO_TRIAGED_LABEL,
  authorTrusted,
  externallyAuthored,
  externallyAuthoredWorkItem,
  changeRequestFlow,
  externalSourceForWorkItem,
  FACTORY_GITHUB_EVENTS,
  FACTORY_GITLAB_EVENTS,
  FACTORY_ROLE_STAGES,
  FACTORY_RULE_BOARDS,
  FACTORY_RULE_REJECTION_CODES,
  FACTORY_RULE_SOURCES,
  FACTORY_RULE_STAGES,
  FACTORY_TRIAGE_TYPES,
  factoryLaneForRole,
  factoryRuleSourceForWorkItem,
  factoryRuleStage,
  isFactoryRole,
  isFactoryRuleStage,
  isFactoryTriageType,
  isTerminalFactoryRuleStage,
  isWorkingFactoryRuleStage,
  needsApproval,
  NEEDS_APPROVAL_LABEL,
  WORK_CHANGE_REQUESTS,
  WORK_ITEM_SOURCES,
  workItemSource,
} from './rules/types.ts';
export type {
  FactoryBoardRuleLeaf,
  FactoryBoundRuleContext,
  FactoryCommitDecision,
  FactoryDismissStaleReviewsDecision,
  FactoryGithubEventName,
  FactoryGithubRuleContext,
  FactoryGitLabEventName,
  FactoryGitLabRuleContext,
  FactoryInvokeSkillDecision,
  FactoryNotifyDecision,
  FactoryRole,
  FactoryRuleActor,
  FactoryRuleBoard,
  FactoryRuleBoardClosure,
  FactoryRuleChangeRequests,
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
