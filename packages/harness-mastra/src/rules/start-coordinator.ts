import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';

import { boardForWorkItem } from '@factory/core';
import { primeTenantCredentialsForTenant } from '@factory/credentials';
import { hydrateFactorySession, resolveFactorySessionModel } from '@factory/session';
import { resolveWorkItemRepository } from '@factory/session';
import type { EnvironmentRepositoryRef } from '@factory/session';
import type { FactoryProjectsStorage } from '@factory/store';
import type { SourceControlSession, SourceControlStorageHandle } from '@factory/store';
import type { CreateWorkItemInput, WorkItemRow, WorkItemsStorage } from '@factory/store';
import type { FactoryTransitionService } from '@factory/runtime';
import { externallyAuthoredWorkItem } from '@factory/core';
import type { FactoryRuleStage, FactoryTransitionResult } from '@factory/core';

export interface FactoryStartRequest {
  orgId: string;
  userId: string;
  factoryProjectId: string;
  sessionId: string;
  threadTitle: string;
  kickoffKey: string;
  /** Where the arrival path lands the card; a session opened on an existing card names none. */
  destinationStage?: FactoryRuleStage;
  /** The Factory's default model; runs bill the organization's credentials. */
  defaultModelId?: string;
  workItem: {
    id?: string;
    role: string;
    input: CreateWorkItemInput;
  };
  requestContext?: RequestContext;
}

export class UntrustedSharedSessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Session ${sessionId} already shares memory with this Factory, so it cannot run untrusted content. Start the run in a new session.`,
    );
    this.sessionId = sessionId;
    this.name = 'UntrustedSharedSessionError';
  }
}

/**
 * The memory resource a run works on. Trusted runs share the Factory's resource.
 * A run that reads attacker-controllable content (a pull request checkout, or a
 * card written outside the write-access circle) keeps its own resource, so it can
 * neither plant observations that trusted runs read nor read what they observed.
 * A session that was isolated stays isolated; one already sharing memory refuses
 * untrusted work instead of carrying that memory into it.
 */
async function runMemoryResource(
  controller: Pick<FactoryController, 'queryThreadById'>,
  input: { sessionId: string; factoryProjectId: string; untrusted: boolean },
): Promise<string> {
  const existing = await controller.queryThreadById({ threadId: input.sessionId });
  if (existing?.resourceId === input.sessionId) return input.sessionId;
  if (!input.untrusted) return existing?.resourceId ?? input.factoryProjectId;
  if (existing) throw new UntrustedSharedSessionError(input.sessionId);
  return input.sessionId;
}

export class WorkItemRepositoryError extends Error {
  readonly code: 'repository_mismatch' | 'repository_ambiguous' | 'repository_unlinked';
  readonly candidates: string[];

  constructor(
    code: 'repository_mismatch' | 'repository_ambiguous' | 'repository_unlinked',
    message: string,
    candidates: string[] = [],
  ) {
    super(message);
    this.code = code;
    this.candidates = candidates;
    this.name = 'WorkItemRepositoryError';
  }
}

export class FactoryStartTransitionError extends Error {
  readonly result: Extract<FactoryTransitionResult, { status: 'rejected' }>;

  constructor(result: Extract<FactoryTransitionResult, { status: 'rejected' }>) {
    super(result.reason);
    this.name = 'FactoryStartTransitionError';
    this.result = result;
  }
}

export interface FactoryStartPreparedResult {
  workItemId: string;
  bindingId: string;
  threadId: string;
  resourceId: string;
  sessionId: string;
  branch: string;
  revision: number;
  kickoffStatus: 'pending' | 'leased' | 'retry' | 'sent' | 'failed';
  replayed: boolean;
}

type FactoryController = AgentController<MastraCodeState>;
type FactorySession = Awaited<ReturnType<FactoryController['createSession']>>;

/** The source-control session a start runs in, checked against the request's org, user and factory. */
export async function resolveSourceSession(
  storage: SourceControlStorageHandle,
  request: Pick<FactoryStartRequest, 'orgId' | 'userId' | 'factoryProjectId' | 'sessionId'>,
): Promise<SourceControlSession & { projectRepositoryId: string }> {
  const session = await storage.sessions.getBySessionId(request.sessionId);
  if (!session || session.orgId !== request.orgId || session.userId !== request.userId) {
    throw new Error('Factory session not found');
  }
  const projectRepositoryId = session.projectRepositoryId;
  if (!projectRepositoryId) throw new Error('Factory session repository not found');
  const projectRepository = await storage.projectRepositories.get({ orgId: request.orgId, id: projectRepositoryId });
  if (!projectRepository) throw new Error('Factory session repository not found');
  const connection = await storage.connections.get({ orgId: request.orgId, id: projectRepository.connectionId });
  if (!connection || connection.factoryProjectId !== request.factoryProjectId) {
    throw new Error('Factory session does not belong to this project');
  }
  return { ...session, projectRepositoryId };
}

/**
 * What the agent is told about where it works. A card bound to one
 * repository names it; a card that names none spans the environment, and the
 * agent changes whichever repositories the task needs, one change request each.
 */
export function targetRepositoryInstructionFor(repository: {
  slug: string;
  environment?: EnvironmentRepositoryRef[];
}): string {
  if (repository.environment && repository.environment.length > 1) {
    return `Workspace repositories: ${repository.environment.map(entry => entry.slug).join(', ')}. This task is not bound to one of them: change every repository the task needs, on this session's branch. Push and open a change request in each repository you changed, passing \`repository\` to the source-control tools; leave repositories you did not change alone.`;
  }
  return `Target repository: ${repository.slug}. Before editing files or creating a pull request, verify this session's checkout matches the target repository.`;
}

function isTargetRepositoryInstruction(instruction: string): boolean {
  return instruction.startsWith('Target repository: ') || instruction.startsWith('Workspace repositories: ');
}

async function configureThread(session: FactorySession, request: FactoryStartRequest): Promise<string> {
  const threadId = session.thread.requireId();
  // Derived from the work item, not a user rename, so leave the title
  // unpinned and let auto-naming keep refining it.
  await session.thread.rename({ title: request.threadTitle, pin: false });
  await session.thread.setSetting({ key: 'factorySessionId', value: request.sessionId });
  return threadId;
}

/**
 * The repository link a start is filed under: the card's, which must be the
 * source session's. A card that names no repository runs across the
 * environment, so a session filed under any environment repository fits it.
 */
export async function resolveStartRepository({
  sourceControl,
  request,
  sourceSession,
  storedItem,
}: {
  sourceControl: SourceControlStorageHandle;
  request: Pick<FactoryStartRequest, 'orgId' | 'factoryProjectId' | 'workItem'>;
  sourceSession: SourceControlSession & { projectRepositoryId: string };
  storedItem: WorkItemRow | null;
}): Promise<{ slug: string; projectRepositoryId: string; environment?: EnvironmentRepositoryRef[] }> {
  let repository = await resolveWorkItemRepository({
    sourceControl,
    orgId: request.orgId,
    factoryProjectId: request.factoryProjectId,
    item: storedItem ?? { metadata: request.workItem.input.metadata ?? null },
  });
  if (repository.status === 'ambiguous') {
    // A retry of this role's existing session keeps its already-chosen
    // repository; a newly minted session must not choose for the card.
    if (storedItem?.sessions[request.workItem.role]?.sessionId !== sourceSession.sessionId) {
      throw new WorkItemRepositoryError(
        'repository_ambiguous',
        `Choose a repository for this work item: ${repository.candidates.join(', ')}.`,
        repository.candidates,
      );
    }
    const link = await sourceControl.projectRepositories.get({
      orgId: request.orgId,
      id: sourceSession.projectRepositoryId,
    });
    const linked = link && (await sourceControl.repositories.get({ orgId: request.orgId, id: link.repositoryId }));
    const currentLinks = link
      ? await sourceControl.projectRepositories.list({ orgId: request.orgId, connectionId: link.connectionId })
      : [];
    if (
      !linked ||
      !repository.candidates.includes(linked.slug) ||
      !currentLinks.some(candidate => candidate.id === sourceSession.projectRepositoryId)
    ) {
      throw new WorkItemRepositoryError(
        'repository_unlinked',
        'The existing session repository is not linked to this Factory.',
      );
    }
    repository = { status: 'resolved', slug: linked.slug, projectRepositoryId: sourceSession.projectRepositoryId };
  }
  if (repository.status === 'unlinked') {
    throw new WorkItemRepositoryError('repository_unlinked', repository.hint);
  }
  if (repository.projectRepositoryId !== sourceSession.projectRepositoryId && repository.environment) {
    // A card that names no repository runs across the environment, so a
    // session filed under any of its repositories is that card's workspace.
    const filedUnder = repository.environment.find(
      entry => entry.projectRepositoryId === sourceSession.projectRepositoryId,
    );
    if (filedUnder) return { ...filedUnder, environment: repository.environment };
  }
  if (repository.projectRepositoryId !== sourceSession.projectRepositoryId) {
    throw new WorkItemRepositoryError(
      'repository_mismatch',
      `This run session is bound to a different repository than ${repository.slug}.`,
    );
  }
  return repository;
}

/**
 * Records a prepared start: binds the card's role to the session's thread,
 * moves the card to the arrival lane and marks the kickoff sent. Shared by
 * every harness's start path, so a binding means the same thing whichever
 * engine runs the session.
 */
export async function commitRunStart({
  storage,
  transitionService,
  request,
  sourceSession,
  threadId,
  resourceId,
  onPrepared,
}: {
  storage: Pick<WorkItemsStorage, 'prepareRunStart' | 'markPendingStart'>;
  transitionService?: Pick<FactoryTransitionService, 'transition'>;
  request: FactoryStartRequest;
  sourceSession: Pick<SourceControlSession, 'sessionId' | 'branch'>;
  threadId: string;
  resourceId: string;
  onPrepared?: (item: WorkItemRow) => Promise<void>;
}): Promise<FactoryStartPreparedResult> {
  const prepared = await storage.prepareRunStart({
    orgId: request.orgId,
    userId: request.userId,
    factoryProjectId: request.factoryProjectId,
    workItem: { id: request.workItem.id, input: request.workItem.input },
    role: request.workItem.role,
    session: { sessionId: sourceSession.sessionId, branch: sourceSession.branch, threadId },
    resourceId,
    kickoffKey: request.kickoffKey,
    kickoffMessage: null,
  });
  await onPrepared?.(prepared.item);

  let revision = prepared.item.revision;
  const destinationStage = request.destinationStage;
  if (destinationStage && (prepared.item.stages.length !== 1 || prepared.item.stages[0] !== destinationStage)) {
    if (!transitionService) throw new Error('Factory transition service is unavailable.');
    const transition = await transitionService.transition({
      orgId: request.orgId,
      factoryProjectId: request.factoryProjectId,
      workItemId: prepared.item.id,
      board: boardForWorkItem(prepared.item),
      stage: destinationStage,
      expectedRevision: prepared.item.revision,
      actor: { type: 'human', id: request.userId },
      ingress: { type: 'human', identity: `start:${request.kickoffKey}:transition` },
      cause: 'run_start',
    });
    if (transition.status === 'rejected') {
      await storage.markPendingStart(prepared.binding.id, 'failed', transition.reason);
      throw new FactoryStartTransitionError(transition);
    }
    revision = transition.revision;
  }

  await storage.markPendingStart(prepared.binding.id, 'sent');
  prepared.pendingStart.status = 'sent';

  return {
    workItemId: prepared.item.id,
    bindingId: prepared.binding.id,
    threadId,
    resourceId,
    sessionId: sourceSession.sessionId,
    branch: sourceSession.branch,
    revision,
    kickoffStatus: prepared.pendingStart.status,
    replayed: prepared.replayed,
  };
}

export class FactoryStartCoordinator {
  readonly #controller: FactoryController;
  readonly #storage: WorkItemsStorage;
  readonly #transitionService?: Pick<FactoryTransitionService, 'transition'>;
  readonly #sourceControl?:
    | SourceControlStorageHandle
    | ((
        request: FactoryStartRequest,
      ) => SourceControlStorageHandle | undefined | Promise<SourceControlStorageHandle | undefined>);
  readonly #projects?: FactoryProjectsStorage;

  constructor(
    controller: FactoryController,
    storage: WorkItemsStorage,
    transitionService?: Pick<FactoryTransitionService, 'transition'>,
    sourceControl?:
      | SourceControlStorageHandle
      | ((
          request: FactoryStartRequest,
        ) => SourceControlStorageHandle | undefined | Promise<SourceControlStorageHandle | undefined>),
    sessionModel?: { projects: FactoryProjectsStorage },
  ) {
    this.#controller = controller;
    this.#storage = storage;
    this.#transitionService = transitionService;
    this.#sourceControl = sourceControl;
    this.#projects = sessionModel?.projects;
  }

  async prepare(request: FactoryStartRequest): Promise<FactoryStartPreparedResult> {
    const storage = this.#storage;
    const sourceControl =
      typeof this.#sourceControl === 'function' ? await this.#sourceControl(request) : this.#sourceControl;
    if (!sourceControl) throw new Error('Factory source control storage is unavailable');
    const sourceSession = await resolveSourceSession(sourceControl, request);
    const sessionModel = this.#projects
      ? await resolveFactorySessionModel({
          projects: this.#projects,
          factoryProjectId: request.factoryProjectId,
          orgId: request.orgId,
        })
      : { modelId: request.defaultModelId };
    const storedItem = request.workItem.id
      ? await storage.get({ orgId: request.orgId, id: request.workItem.id })
      : null;
    const repository = await resolveStartRepository({ sourceControl, request, sourceSession, storedItem });
    const requestContext = request.requestContext ?? new RequestContext();
    // Preserve an authenticated caller when present. Autonomous starts still
    // need a principal so deployed credential resolution can authenticate the
    // request before selecting the stamped session owner's exclusive scope.
    const existingUser = requestContext.get('user');
    if (!existingUser || typeof existingUser !== 'object') {
      requestContext.set('user', {
        id: request.userId,
        organizationId: request.orgId,
      });
    }
    // Sessions kicked off against third-party content (a PR under review, or
    // any pull-request-sourced work item) get `untrustedCheckout` so the SDK
    // never ingests the checkout's AGENTS.md/CLAUDE.md into the system prompt
    // or reminders — those files are attacker-writable in a PR branch.
    const untrustedCheckout = request.workItem.input.externalSource?.type === 'pull-request';
    // The trusted ref the SDK may serve project instruction files from on an
    // untrusted checkout (the PR's base branch). Prefer the session record's
    // base branch; fall back to the intake metadata captured from the PR.
    const metadataBaseBranch = request.workItem.input.metadata?.baseBranch;
    const baseRef =
      (sourceSession.baseBranch || undefined) ??
      (typeof metadataBaseBranch === 'string' && metadataBaseBranch ? metadataBaseBranch : undefined);
    const memoryResourceId = await runMemoryResource(this.#controller, {
      sessionId: sourceSession.sessionId,
      factoryProjectId: request.factoryProjectId,
      untrusted:
        untrustedCheckout ||
        externallyAuthoredWorkItem(
          storedItem ?? {
            externalSource: request.workItem.input.externalSource ?? null,
            metadata: request.workItem.input.metadata ?? null,
          },
        ),
    });
    const sessionTags = {
      factoryProjectId: request.factoryProjectId,
      projectRepositoryId: sourceSession.projectRepositoryId,
    };
    // The run is addressed by its session id; its threads and memory belong to
    // the Factory, so concurrent runs share one memory resource.
    const session = await this.#controller.createSession({
      id: sourceSession.sessionId,
      ownerId: request.userId,
      resourceId: memoryResourceId,
      threadId: sourceSession.sessionId,
      requestContext,
      tags: sessionTags,
    });
    // Bound-agent authority gates (the transition tool, the factory-phase
    // processor, workspace token selection) resolve the session address from
    // controller state. Seed it server-side — `tags` covers fresh creation,
    // the explicit setState covers get-or-create returning a session another
    // caller created without them — so autonomous runs never depend on a
    // browser connecting to populate the state. `untrustedCheckout` is a
    // boolean so it rides only on state (tags are string-valued).
    const targetRepositoryInstruction = targetRepositoryInstructionFor(repository);
    const existingPluginInstructions = session.state.get()?.pluginInstructions ?? [];
    await session.state.set({
      ...sessionTags,
      // The authoritative org id for every downstream identity read (the
      // memory seam's organizationId): the session owner is a USER id, not an
      // org, so it must never be improvised from ownerId.
      factoryOrgId: request.orgId,
      factoryModelScope: 'factory',
      factoryOwnerUserId: sourceSession.userId,
      pluginInstructions: [
        // Replace any earlier target line; the card may have moved between
        // one repository and the whole environment.
        ...existingPluginInstructions.filter(instruction => !isTargetRepositoryInstruction(instruction)),
        targetRepositoryInstruction,
      ],
      ...(untrustedCheckout ? { untrustedCheckout: true, ...(baseRef ? { baseRef } : {}) } : {}),
    });
    await primeTenantCredentialsForTenant({
      orgId: request.orgId,
      userId: sourceSession.userId,
      credentialScope: 'factory',
    });
    // Apply the factory's main model before any model-dependent run work.
    // Observational-memory settings are loaded per invocation by the input processor.
    await hydrateFactorySession(session, {
      orgId: request.orgId,
      ownerUserId: sourceSession.userId,
      defaultModelId: sessionModel.modelId,
    });
    // The tool is `requireApproval`, and that prompt parks the run whether or not
    // someone pressed Start — a person is reading the plan, not an approval queue.
    // Starting the run was already the say-so; the rules engine still governs.
    await session.permissions.setForTool({ toolName: 'factory_transition_work_item', policy: 'allow' });
    const threadId = await configureThread(session, request);
    return commitRunStart({
      storage,
      transitionService: this.#transitionService,
      request,
      sourceSession,
      threadId,
      resourceId: memoryResourceId,
      // The thread learns its card as soon as the binding exists.
      onPrepared: item => session.thread.setSetting({ key: 'factoryWorkItemId', value: item.id }),
    });
  }
}
