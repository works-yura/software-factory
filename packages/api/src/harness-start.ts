import { FactoryStartCoordinator } from '@factory/harness-mastra';
import type { FactoryStartPreparedResult, FactoryStartRequest } from '@factory/harness-mastra';
import { FactoryDispatchError } from '@factory/store';
import type { FactoryHarnessKind, FactoryProjectsStorage } from '@factory/store';

/** The start path of a harness other than Mastra. */
export interface HarnessStartCoordinator extends Pick<FactoryStartCoordinator, 'prepare'> {
  /**
   * Whether this harness already holds the session (a card started on it before
   * the Factory switched harness). Such a session keeps starting here whatever
   * the Factory's harness is now. Without it, only the Factory's harness counts.
   */
  owns?(sessionId: string): Promise<boolean>;
}

/** The start paths of harnesses other than Mastra, keyed by harness. */
export type HarnessStartCoordinators = Partial<Record<Exclude<FactoryHarnessKind, 'mastra'>, HarnessStartCoordinator>>;

type MastraThreadLookup = Pick<ConstructorParameters<typeof FactoryStartCoordinator>[0], 'queryThreadById'>;

/**
 * The start coordinator every start goes through (rules, the board's Start,
 * session tools). A subclass rather than a wrapper so every consumer typed
 * against `FactoryStartCoordinator` keeps working.
 *
 * Which harness a start goes to:
 * 1. the harness that already holds `request.sessionId`, so a card that started
 *    before the Factory switched harness finishes on the one it started on
 *    (a session's memory, thread and events belong to its harness):
 *    - another harness holds it when its `owns` says so (Claude Code: its session store has it);
 *    - Mastra holds it when the Mastra controller has the session's thread. A
 *      Mastra start creates that thread with the session id as its id, the
 *      same lookup the Mastra start uses to keep a session's memory resource;
 * 2. otherwise the Factory's current harness.
 */
export class HarnessRoutingStartCoordinator extends FactoryStartCoordinator {
  readonly #projects: Pick<FactoryProjectsStorage, 'get'>;
  readonly #others: HarnessStartCoordinators;
  readonly #mastraThreads: MastraThreadLookup;

  constructor(
    args: ConstructorParameters<typeof FactoryStartCoordinator>,
    routing: { projects: Pick<FactoryProjectsStorage, 'get'>; coordinators: HarnessStartCoordinators },
  ) {
    super(...args);
    this.#projects = routing.projects;
    this.#others = routing.coordinators;
    this.#mastraThreads = args[0];
  }

  /** The harness that already holds this session, if any. */
  async #owner(sessionId: string): Promise<FactoryHarnessKind | undefined> {
    for (const [harness, coordinator] of Object.entries(this.#others) as Array<
      [Exclude<FactoryHarnessKind, 'mastra'>, HarnessStartCoordinator | undefined]
    >) {
      if (coordinator?.owns && (await coordinator.owns(sessionId))) return harness;
    }
    const thread = await this.#mastraThreads.queryThreadById?.({ threadId: sessionId });
    return thread ? 'mastra' : undefined;
  }

  override async prepare(request: FactoryStartRequest): Promise<FactoryStartPreparedResult> {
    let harness = await this.#owner(request.sessionId);
    if (!harness) {
      const project = await this.#projects.get({ orgId: request.orgId, id: request.factoryProjectId });
      harness = project?.harness ?? 'mastra';
    }
    if (harness === 'mastra') return super.prepare(request);
    const coordinator = this.#others[harness];
    if (!coordinator) {
      throw new FactoryDispatchError(
        'session_unavailable',
        `This Factory runs its agents on ${harness}, which this server does not have configured.`,
      );
    }
    return coordinator.prepare(request);
  }
}
