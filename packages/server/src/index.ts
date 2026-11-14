export { BoardDefinitionError, createBoardRegistry, DEFAULT_PHASE_CONTEXT, defineBoard, FACTORY_AGENT_ID } from '@factory/core';
export { workBoard } from '@factory/pipelines';
export type { WorkBoardPhase } from '@factory/pipelines';
export { defaultBoards } from '@factory/pipelines';
export type {
  BoardDefinition,
  BoardEventIntegration,
  BoardEventRules,
  BoardPhase,
  BoardPhaseDefinition,
  BoardPhaseExitTool,
  BoardPhaseRunner,
  BoardRegistry,
  BoardSourceClosed,
  BoardTransition,
  BoardTransitionPolicy,
  BoardTransitionPolicyContext,
  BoardTransitionPolicyResult,
  InstalledBoard,
  RuleCondition,
  RuleGroup,
  RuleOperator,
} from '@factory/core';
export { BoardWriteError } from '@factory/runtime';
export { workSeedWithTriage } from '@factory/store';
export type { StoredBoardInput, StoredBoardScope, StoredPhaseInput } from '@factory/store';
export { MastraFactory } from './factory.ts';
export { waitForPendingFilesystemCapture } from '@factory/session';
export type {
  MastraArgs,
  MastraFactoryConfig,
  MastraFactorySandboxConfig,
  MastraFactorySandboxOption,
  FactorySandboxStart,
} from './factory.ts';
export { LocalFactorySandbox, type LocalFactorySandboxOptions } from '@factory/sandbox';
export { LocalEnvironmentTemplate, type LocalEnvironmentTemplateOptions } from '@factory/sandbox';
// The option type for `MastraFactoryConfig.github.rules`, so callers can
// annotate a custom handler without importing the deep integration subpath.
export type { GithubRuleOverrides } from '@factory/integration-github';
export type { FactorySandboxContext, SessionSetupGate, SessionSetupRun } from '@factory/sandbox';
export { ChannelIdentityStorage } from '@factory/store';
// Attachment byte stores: the local one, and the seam an object store (S3…) implements.
export { LocalFileBlobStore } from '@factory/store';
export type { AttachmentBlobStore } from '@factory/store';
export type {
  ChannelAccountLink,
  ChannelAccountLinkEntry,
  ChannelAccountLinkKey,
  ChannelAccountLinkNames,
} from '@factory/store';
export { FactoryProjectsStorage } from '@factory/store';
export type { FactoryProject } from '@factory/store';
export { WorkItemsStorage } from '@factory/store';
export type { BoardItemRow, Card, CreateWorkItemInput, WorkItemRow } from '@factory/store';
export { primarySource } from '@factory/store';
export type { ProviderWorkItemRow, WorkItemProvider, WorkItemSourceRow } from '@factory/store';
export { createStateSigner } from '@factory/auth';
export type { StateSigner, StateTenant } from '@factory/auth';
export { createFactorySecretEncryption, createPlaintextFactorySecretEncryption } from '@factory/store';
export type {
  DecryptedFactorySecret,
  FactorySecretEncryption,
  FactorySecretEncryptionConfig,
  FactorySecretEncryptionKey,
} from '@factory/store';
export { createFactoryRouteAuth } from '@factory/auth';
export type { RouteAuth } from '@factory/http';
// The integration seam, so a host can implement `FactoryIntegration` from
// outside this package — the contract's stated design for third parties.
// Built-ins (GitHub, GitLab) implement the same interface from inside.
export type {
  FactoryIntegration,
  IntegrationContext,
  IntegrationHooks,
  IntegrationTools,
} from '@factory/integrations';
export { attachOnFirstRequest, DEVICE_BASE_PATH } from './device.ts';
export type { FactoryDeviceConfig } from './device.ts';
export * from './agent-user/index.ts';
// The harness modules (ADR-0044): the registry, the module shape and the deployment's harness configs.
export { harnessConfigsFromEnv, mastraHarnessModule, SERVER_HARNESS_MODULES } from './harnesses/registry.ts';
export type { HarnessModuleConfigs } from './harnesses/registry.ts';
export type * from './harnesses/module.ts';
