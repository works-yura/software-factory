// The app-server types this harness sends and reads: the v2 protocol's initialize, account, model
// list, thread and turn requests, the notifications a turn streams and the requests that wait for a
// person. Only the fields the harness uses are spelled out; the app-server sends more.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// ---- initialize / account / models -------------------------------------------------------------

export interface InitializeParams {
  readonly clientInfo: { readonly name: string; readonly title?: string; readonly version: string };
  readonly capabilities?: {
    readonly experimentalApi?: boolean;
    readonly optOutNotificationMethods?: ReadonlyArray<string>;
  } | null;
}

export interface InitializeResponse {
  readonly userAgent: string;
  readonly codexHome?: string;
  readonly platformFamily?: string;
  readonly platformOs?: string;
}

export type CodexAccount =
  | { readonly type: 'apiKey' }
  | { readonly type: 'chatgpt'; readonly email: string | null; readonly planType: string }
  | { readonly type: 'amazonBedrock'; readonly usesCodexManagedCredentials?: boolean };

export interface GetAccountResponse {
  readonly account: CodexAccount | null;
  readonly requiresOpenaiAuth: boolean;
}

/**
 * `account/login/start`: a device sign-in (a page and a one-time code the person enters there),
 * or tokens the host holds and refreshes (`chatgptAuthTokens`: Codex keeps them in memory only and
 * asks the host again with `account/chatgptAuthTokens/refresh` when the backend refuses them).
 */
export type LoginAccountParams =
  | { readonly type: 'chatgptDeviceCode' }
  | {
      readonly type: 'chatgptAuthTokens';
      readonly accessToken: string;
      readonly chatgptAccountId: string;
      readonly chatgptPlanType?: string | null;
    };

export type LoginAccountResponse =
  | { readonly type: 'chatgptDeviceCode'; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string }
  | { readonly type: 'chatgptAuthTokens' }
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | { readonly type: 'apiKey' };

export interface AccountLoginCompletedNotification {
  readonly loginId: string | null;
  readonly success: boolean;
  readonly error: string | null;
}

export interface ChatgptAuthTokensRefreshParams {
  readonly reason: 'unauthorized' | (string & {});
  /** The workspace Codex was using, a hint for a host with several. */
  readonly previousAccountId?: string | null;
}

export interface ChatgptAuthTokensRefreshResponse {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  readonly chatgptPlanType: string | null;
}

export interface ModelListParams {
  readonly cursor?: string | null;
}

export interface CodexModelServiceTier {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface CodexListedModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<{ readonly reasoningEffort: string; readonly description?: string }>;
  readonly defaultReasoningEffort: string;
  readonly additionalSpeedTiers?: ReadonlyArray<string>;
  readonly serviceTiers?: ReadonlyArray<CodexModelServiceTier>;
  readonly defaultServiceTier?: string | null;
  readonly inputModalities?: ReadonlyArray<string>;
}

export interface ModelListResponse {
  readonly data: ReadonlyArray<CodexListedModel>;
  readonly nextCursor?: string | null;
}

// ---- threads and turns -------------------------------------------------------------------------

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      readonly granular: {
        readonly mcp_elicitations: boolean;
        readonly request_permissions?: boolean;
        readonly rules: boolean;
        readonly sandbox_approval: boolean;
        readonly skill_approval?: boolean;
      };
    };

export type ApprovalsReviewer = 'user' | 'auto_review';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type SandboxPolicy =
  | { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess?: boolean }
  | {
      readonly type: 'workspaceWrite';
      readonly networkAccess?: boolean;
      readonly writableRoots?: ReadonlyArray<string>;
      readonly excludeSlashTmp?: boolean;
      readonly excludeTmpdirEnvVar?: boolean;
    };

export interface ThreadStartParams {
  readonly approvalPolicy?: AskForApproval | null;
  readonly approvalsReviewer?: ApprovalsReviewer | null;
  readonly baseInstructions?: string | null;
  readonly config?: Readonly<Record<string, JsonValue>> | null;
  readonly cwd?: string | null;
  readonly developerInstructions?: string | null;
  readonly ephemeral?: boolean | null;
  readonly model?: string | null;
  readonly sandbox?: SandboxMode | null;
  readonly serviceName?: string | null;
  readonly serviceTier?: string | null;
}

export interface ThreadResumeParams extends Omit<ThreadStartParams, 'ephemeral' | 'serviceName'> {
  readonly threadId: string;
  readonly excludeTurns?: boolean;
}

export interface CodexThread {
  readonly id: string;
  readonly cwd: string;
  readonly model?: string | null;
  readonly cliVersion?: string;
}

export interface ThreadStartResponse {
  readonly thread: CodexThread;
  readonly model: string;
  readonly cwd: string;
  readonly reasoningEffort?: string | null;
  readonly serviceTier?: string | null;
}

export type ThreadResumeResponse = ThreadStartResponse;

export type UserInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string }
  | { readonly type: 'localImage'; readonly path: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string };

export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface CollaborationMode {
  readonly mode: 'default' | 'plan';
  readonly settings: { readonly model: string; readonly reasoning_effort?: string; readonly developer_instructions?: string | null };
}

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<UserInput>;
  readonly cwd?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly serviceTier?: string | null;
  readonly summary?: ReasoningSummary | null;
  readonly approvalPolicy?: AskForApproval | null;
  readonly approvalsReviewer?: ApprovalsReviewer | null;
  readonly sandboxPolicy?: SandboxPolicy | null;
  readonly collaborationMode?: CollaborationMode;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type CodexErrorInfo =
  | string
  | { readonly httpConnectionFailed: { readonly httpStatusCode?: number | null } }
  | { readonly responseStreamConnectionFailed: { readonly httpStatusCode?: number | null } }
  | { readonly responseStreamDisconnected: { readonly httpStatusCode?: number | null } }
  | { readonly responseTooManyFailedAttempts: { readonly httpStatusCode?: number | null } }
  | { readonly [key: string]: unknown };

export interface TurnError {
  readonly message: string;
  readonly additionalDetails?: string | null;
  readonly codexErrorInfo?: CodexErrorInfo | null;
}

export interface CodexTurn {
  readonly id: string;
  readonly status: TurnStatus;
  readonly error?: TurnError | null;
  readonly items?: ReadonlyArray<ThreadItem>;
  readonly durationMs?: number | null;
}

export interface TurnStartResponse {
  readonly turn: CodexTurn;
}

export interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

// ---- items -------------------------------------------------------------------------------------

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type PatchChangeKind =
  | { readonly type: 'add' }
  | { readonly type: 'delete' }
  | { readonly type: 'update'; readonly move_path?: string | null };

export interface FileUpdateChange {
  readonly path: string;
  readonly kind: PatchChangeKind;
  readonly diff: string;
}

export type WebSearchAction =
  | { readonly type: 'search'; readonly query?: string | null; readonly queries?: ReadonlyArray<string> | null }
  | { readonly type: 'openPage'; readonly url?: string | null }
  | { readonly type: 'findInPage'; readonly url?: string | null; readonly pattern?: string | null }
  | { readonly type: 'other' };

export type ThreadItem =
  | { readonly type: 'userMessage'; readonly id: string; readonly content: ReadonlyArray<unknown> }
  | { readonly type: 'agentMessage'; readonly id: string; readonly text: string; readonly phase?: string | null }
  | { readonly type: 'plan'; readonly id: string; readonly text: string }
  | { readonly type: 'reasoning'; readonly id: string; readonly summary?: ReadonlyArray<string>; readonly content?: ReadonlyArray<string> }
  | {
      readonly type: 'commandExecution';
      readonly id: string;
      readonly command: string;
      readonly cwd: string;
      readonly status: ItemStatus;
      readonly aggregatedOutput?: string | null;
      readonly exitCode?: number | null;
      readonly durationMs?: number | null;
    }
  | { readonly type: 'fileChange'; readonly id: string; readonly changes: ReadonlyArray<FileUpdateChange>; readonly status: ItemStatus }
  | {
      readonly type: 'mcpToolCall';
      readonly id: string;
      readonly server: string;
      readonly tool: string;
      readonly arguments: JsonValue;
      readonly status: ItemStatus;
      readonly result?: { readonly content: ReadonlyArray<JsonValue>; readonly structuredContent?: JsonValue } | null;
      readonly error?: { readonly message: string } | null;
    }
  | {
      readonly type: 'dynamicToolCall';
      readonly id: string;
      readonly tool: string;
      readonly namespace?: string | null;
      readonly arguments: JsonValue;
      readonly status: ItemStatus;
      readonly success?: boolean | null;
      readonly contentItems?: ReadonlyArray<{ readonly type: string; readonly text?: string }> | null;
    }
  | { readonly type: 'webSearch'; readonly id: string; readonly query: string; readonly action?: WebSearchAction | null }
  | { readonly type: 'imageView'; readonly id: string; readonly path: string }
  | { readonly type: 'contextCompaction'; readonly id: string }
  | { readonly type: 'enteredReviewMode' | 'exitedReviewMode'; readonly id: string; readonly review: string }
  | { readonly type: string; readonly id: string };

// ---- notifications -----------------------------------------------------------------------------

export interface TurnStartedNotification {
  readonly threadId: string;
  readonly turn: CodexTurn;
}

export interface TurnCompletedNotification {
  readonly threadId: string;
  readonly turn: CodexTurn;
}

export interface ItemNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: ThreadItem;
}

export interface DeltaNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
}

export interface TurnPlanStep {
  readonly step: string;
  readonly status: 'pending' | 'inProgress' | 'completed';
}

export interface TurnPlanUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<TurnPlanStep>;
}

export interface TokenUsageBreakdown {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface ThreadTokenUsage {
  readonly total: TokenUsageBreakdown;
  readonly last: TokenUsageBreakdown;
  readonly modelContextWindow?: number | null;
}

export interface ThreadTokenUsageUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage: ThreadTokenUsage;
}

export interface ErrorNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly willRetry: boolean;
  readonly error: TurnError;
}

export interface RateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface RateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
  readonly individualLimit?: { readonly remainingPercent: number; readonly resetsAt: number } | null;
}

export interface AccountRateLimitsUpdatedNotification {
  readonly rateLimits: RateLimitSnapshot;
}

// ---- requests that wait for a person -----------------------------------------------------------

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandExecutionRequestApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly approvalId?: string | null;
  readonly command?: string | null;
  readonly cwd?: string | null;
  readonly reason?: string | null;
}

export interface FileChangeRequestApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
}

export interface PermissionProfile {
  readonly fileSystem?: {
    readonly read?: ReadonlyArray<string> | null;
    readonly write?: ReadonlyArray<string> | null;
    readonly entries?: ReadonlyArray<{ readonly access: 'read' | 'write' | string }> | null;
  } | null;
  readonly network?: unknown;
}

export interface PermissionsRequestApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly cwd: string;
  readonly reason?: string | null;
  readonly permissions: PermissionProfile;
}

export interface PermissionsRequestApprovalResponse {
  readonly permissions: PermissionProfile;
  readonly scope: 'turn' | 'session';
}

export interface UserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther?: boolean;
  readonly isSecret?: boolean;
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description: string }> | null;
}

export interface ToolRequestUserInputParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

export interface ToolRequestUserInputResponse {
  readonly answers: Readonly<Record<string, { readonly answers: ReadonlyArray<string> }>>;
}

// ---- method tables -----------------------------------------------------------------------------

export interface ClientRequests {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'account/read': { params: { readonly refreshToken?: boolean }; result: GetAccountResponse };
  'account/login/start': { params: LoginAccountParams; result: LoginAccountResponse };
  'account/login/cancel': { params: { readonly loginId: string }; result: Record<string, unknown> };
  'account/rateLimits/read': { params: null; result: { rateLimits: RateLimitSnapshot; rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null } };
  'model/list': { params: ModelListParams; result: ModelListResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: Record<string, unknown> };
}

export interface ServerNotifications {
  'turn/started': TurnStartedNotification;
  'turn/completed': TurnCompletedNotification;
  'item/started': ItemNotification;
  'item/completed': ItemNotification;
  'item/agentMessage/delta': DeltaNotification;
  'item/reasoning/summaryTextDelta': DeltaNotification;
  'item/reasoning/textDelta': DeltaNotification;
  'item/commandExecution/outputDelta': DeltaNotification;
  'item/plan/delta': DeltaNotification;
  'turn/plan/updated': TurnPlanUpdatedNotification;
  'thread/tokenUsage/updated': ThreadTokenUsageUpdatedNotification;
  'account/rateLimits/updated': AccountRateLimitsUpdatedNotification;
  'account/login/completed': AccountLoginCompletedNotification;
  error: ErrorNotification;
}

export interface ServerRequests {
  'item/commandExecution/requestApproval': { params: CommandExecutionRequestApprovalParams; result: { decision: ApprovalDecision } };
  'item/fileChange/requestApproval': { params: FileChangeRequestApprovalParams; result: { decision: ApprovalDecision } };
  'item/permissions/requestApproval': { params: PermissionsRequestApprovalParams; result: PermissionsRequestApprovalResponse };
  'item/tool/requestUserInput': { params: ToolRequestUserInputParams; result: ToolRequestUserInputResponse };
  'account/chatgptAuthTokens/refresh': { params: ChatgptAuthTokensRefreshParams; result: ChatgptAuthTokensRefreshResponse };
  'mcpServer/elicitation/request': { params: { threadId?: string; turnId?: string | null; serverName?: string; message?: string }; result: { action: 'accept' | 'decline' | 'cancel'; content?: JsonValue } };
}

export type ClientRequestMethod = keyof ClientRequests;
export type ServerNotificationMethod = keyof ServerNotifications;
export type ServerRequestMethod = keyof ServerRequests;
