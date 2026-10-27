export { BoardDefinitionError, createBoardRegistry, defineBoard } from '@factory/core';
export { reviewBoard, workBoard } from '@factory/pipelines';
export type { ReviewBoardPhase, WorkBoardPhase } from '@factory/pipelines';
export { defaultBoards } from '@factory/pipelines';
export type {
  BoardDefinition,
  BoardEventIntegration,
  BoardEventRules,
  BoardPhaseDefinition,
  BoardRegistry,
  BoardSourceClosed,
  BoardTransition,
  BoardTransitionPolicy,
  BoardTransitionPolicyContext,
  BoardTransitionPolicyResult,
  InstalledBoard,
} from '@factory/core';
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
// The option type for `MastraFactoryConfig.github.rules`, so callers can
// annotate a custom handler without importing the deep integration subpath.
export type { GithubRuleOverrides } from './integrations/github/default-rules.ts';
export type { FactorySandboxContext, SessionSetupGate, SessionSetupRun } from '@factory/sandbox';
export { ChannelIdentityStorage } from '@factory/store';
export type {
  ChannelAccountLink,
  ChannelAccountLinkEntry,
  ChannelAccountLinkKey,
  ChannelAccountLinkNames,
} from '@factory/store';
export { FactoryProjectsStorage } from '@factory/store';
export type { FactoryProject } from '@factory/store';
export { WorkItemsStorage } from '@factory/store';
export type { CreateWorkItemInput, WorkItemRow } from '@factory/store';
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
// Built-ins (GitHub, Linear, Slack) implement the same interface from inside.
export type {
  FactoryIntegration,
  IntegrationContext,
  IntegrationHooks,
  IntegrationTools,
} from '@factory/integrations';
