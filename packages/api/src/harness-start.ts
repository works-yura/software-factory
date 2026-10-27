import { FactoryStartCoordinator } from '@factory/harness-mastra';
import type { FactoryStartPreparedResult, FactoryStartRequest } from '@factory/harness-mastra';
import { FactoryDispatchError } from '@factory/store';
import type { FactoryHarnessKind, FactoryProjectsStorage } from '@factory/store';

/** The start path of a harness other than Mastra, keyed by the harness a factory was created with. */
export type HarnessStartCoordinators = Partial<
  Record<Exclude<FactoryHarnessKind, 'mastra'>, Pick<FactoryStartCoordinator, 'prepare'>>
>;

/**
 * The start coordinator every start goes through (rules, the board's Start,
 * session tools): a factory on Mastra starts as before, any other factory
 * starts on its own harness's coordinator. A subclass rather than a wrapper so
 * every consumer typed against `FactoryStartCoordinator` keeps working.
 */
export class HarnessRoutingStartCoordinator extends FactoryStartCoordinator {
  readonly #projects: Pick<FactoryProjectsStorage, 'get'>;
  readonly #others: HarnessStartCoordinators;

  constructor(
    args: ConstructorParameters<typeof FactoryStartCoordinator>,
    routing: { projects: Pick<FactoryProjectsStorage, 'get'>; coordinators: HarnessStartCoordinators },
  ) {
    super(...args);
    this.#projects = routing.projects;
    this.#others = routing.coordinators;
  }

  override async prepare(request: FactoryStartRequest): Promise<FactoryStartPreparedResult> {
    const project = await this.#projects.get({ orgId: request.orgId, id: request.factoryProjectId });
    const harness = project?.harness ?? 'mastra';
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
