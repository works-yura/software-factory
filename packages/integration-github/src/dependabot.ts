import {
  cardRuleFacts,
  DEPENDABOT_ALERT_SOURCE_TYPE,
  evaluateRuleGroup,
  intakeTarget,
  placesNewCards,
  resolveBoardClosure,
  routeSourceValues,
} from '@factory/core';
import type { BoardRegistry, ExternalWorkItemSource, IntakeRoute, IntakeRoutesReader, RuleFacts } from '@factory/core';
import type { ExternalRepositoryProjectTarget, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';
import { arrivalSourceFacts } from '@factory/store';

import type { ReconcileRepository } from './rules.ts';

/**
 * Dependabot alerts as an intake source (ADR-0042, behaviour of upstream #30254). The GitHub
 * integration reads each linked repository's alerts with its own connection (App installation or
 * token) — never through a proxy — and files an open alert as a card where the project's intake
 * routes place it, like a ClickUp task: only a route that names `source.kind = dependabot_alert`
 * subscribes a project, and only while the organization switched Dependabot intake on
 * (intake config key {@link DEPENDABOT_INTAKE_ID}, off until enabled). A fixed alert finishes its
 * card, a dismissed one cancels it (the board's `sourceClosed`), unless a route handles the close.
 */

/** The intake config key of the organization's Dependabot switch (Settings › Надходження задач). */
export const DEPENDABOT_INTAKE_ID = 'dependabot';

/** The `source.kind` value a route names to take Dependabot alerts. */
export const DEPENDABOT_SOURCE_KIND = 'dependabot_alert';

const DESCRIPTION_LIMIT = 8_000;
const ACTOR = { type: 'system', id: 'github-dependabot-sweep' } as const;
const USER_ID = 'github-dependabot-sweep';

export type DependabotAlertState = 'open' | 'fixed' | 'dismissed' | 'auto_dismissed';

/** One alert as the sweep reads it. */
export interface DependabotAlert {
  number: number;
  state: DependabotAlertState;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** The advisory's severity: `critical`, `high`, `medium`, `low`. */
  severity: string;
  ecosystem: string;
  package: string;
  manifestPath: string | null;
  /** `GHSA-…`. */
  advisory: string;
  cve: string | null;
  summary: string;
  description: string;
  /** The first patched version, when the advisory names one. */
  fixedIn: string | null;
}

export type DependabotAccessProblem = 'permission' | 'disabled' | 'not_found';

/**
 * GitHub refused the alerts of one repository: the connection lacks the "Dependabot alerts: read"
 * permission (`permission`), the repository has Dependabot alerts switched off (`disabled`), or
 * the connection can't see the repository (`not_found`). Surfaced in Settings, never skipped quietly.
 */
export class DependabotAccessError extends Error {
  readonly problem: DependabotAccessProblem;
  constructor(problem: DependabotAccessProblem, message: string) {
    super(message);
    this.name = 'DependabotAccessError';
    this.problem = problem;
  }
}

/** Reads a repository's alerts: the open ones, or the recently closed ones (`closed`). */
export type DependabotAlertLister = (input: {
  installationId: number;
  repository: string;
  state: 'open' | 'closed';
}) => Promise<DependabotAlert[]>;

/** How the last sweep went for one repository, per organization: what Settings shows. */
export interface DependabotRepositoryStatus {
  repository: string;
  checkedAt: string;
  openAlerts?: number;
  problem?: DependabotAccessProblem | 'error';
  message?: string;
}

/**
 * The last sweep's result per organization and repository. Kept in memory: it is a status line,
 * rebuilt by the next sweep (on boot, then on the issue cadence), not data.
 */
export class DependabotStatusBoard {
  readonly #byOrg = new Map<string, Map<string, DependabotRepositoryStatus>>();

  record(orgId: string, status: DependabotRepositoryStatus): void {
    let repositories = this.#byOrg.get(orgId);
    if (!repositories) {
      repositories = new Map();
      this.#byOrg.set(orgId, repositories);
    }
    repositories.set(status.repository.toLowerCase(), status);
  }

  forOrg(orgId: string): DependabotRepositoryStatus[] {
    return [...(this.#byOrg.get(orgId)?.values() ?? [])].sort((a, b) => a.repository.localeCompare(b.repository));
  }
}

export interface DependabotSweepSummary {
  repositories: number;
  checked: number;
  created: number;
  updated: number;
  closed: number;
  failed: number;
  errors: Array<{ repository: string; alert?: number; error: string }>;
}

export interface DependabotSweepOptions {
  listAlerts: DependabotAlertLister;
  projectRepositories: {
    listByExternalRepository(args: {
      installationExternalId: string;
      repositoryExternalId: string;
    }): Promise<ExternalRepositoryProjectTarget[]>;
  };
  intake: Pick<IntakeStorage, 'getConfig'>;
  intakeRoutes: IntakeRoutesReader;
  projectBoards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
  workItems: Pick<WorkItemsStorage, 'getByProjectSource' | 'commitRuleEvaluation' | 'update'>;
  configVersion: string;
  status: DependabotStatusBoard;
  now?: () => Date;
}

/** Whether a route takes Dependabot alerts: it places new cards, names the kind, and matches this alert. */
export function routesSubscribeAlert(routes: readonly IntakeRoute[], facts?: RuleFacts): boolean {
  return routes.some(
    route =>
      route.enabled &&
      placesNewCards(route) &&
      routeSourceValues(route, 'source.kind').includes(DEPENDABOT_SOURCE_KIND) &&
      (facts === undefined || evaluateRuleGroup(route.when, facts)),
  );
}

/** The card key of an alert: the repository id stays when the repository is renamed. */
export function dependabotSourceKey(repositoryId: number, alertNumber: number): string {
  return `${repositoryId}#${alertNumber}`;
}

function alertSource(repository: ReconcileRepository, alert: DependabotAlert): ExternalWorkItemSource {
  return {
    integrationId: 'github',
    type: DEPENDABOT_ALERT_SOURCE_TYPE,
    externalId: dependabotSourceKey(repository.id, alert.number),
    url: alert.url,
  };
}

function alertTitle(alert: DependabotAlert): string {
  return `${alert.package}: ${alert.summary || alert.advisory}`;
}

function alertMetadata(repository: ReconcileRepository, alert: DependabotAlert): Record<string, unknown> {
  return {
    title: alertTitle(alert),
    description: alert.description.slice(0, DESCRIPTION_LIMIT),
    state: alert.state,
    labels: [],
    githubRepositoryId: repository.id,
    dependabotSeverity: alert.severity,
    dependabotEcosystem: alert.ecosystem,
    dependabotPackage: alert.package,
    ...(alert.manifestPath ? { dependabotManifestPath: alert.manifestPath } : {}),
    dependabotAdvisory: alert.advisory,
    ...(alert.cve ? { dependabotCve: alert.cve } : {}),
    ...(alert.fixedIn ? { dependabotFixedIn: alert.fixedIn } : {}),
    sourceCreatedAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    // Dependabot is GitHub itself, but the advisory text comes from outside the repository.
    authorTrusted: false,
  };
}

function sameMetadata(current: Record<string, unknown> | null, desired: Record<string, unknown>): boolean {
  return Object.entries(desired).every(([key, value]) => JSON.stringify(current?.[key]) === JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = 'created' | 'updated' | 'closed' | 'unchanged';

/**
 * One sweep over the given repositories. A repository is read only when a project linking it has
 * Dependabot intake on and a route that takes alerts, so a connection without the permission is
 * never asked for alerts nobody wants.
 */
export function createDependabotSweep(options: DependabotSweepOptions) {
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  const alertFacts = (repository: ReconcileRepository, alert: DependabotAlert, metadata: Record<string, unknown>) => {
    const source = alertSource(repository, alert);
    const workItem = arrivalSourceFacts(source, metadata);
    return cardRuleFacts({ title: alertTitle(alert), metadata, externalSource: source, ...(workItem ? { workItem } : {}) });
  };

  const closeCard = async (
    target: ExternalRepositoryProjectTarget,
    item: WorkItemRow,
    alert: DependabotAlert,
    registry: BoardRegistry,
  ): Promise<boolean> => {
    const board = item.board ? registry.get(item.board) : undefined;
    if (!board || item.stages.some(stage => board.isTerminal(stage))) return false;
    const reason = alert.state === 'fixed' ? 'completed' : 'canceled';
    const identity = `github:dependabot:${item.id}:${alert.state}:${alert.updatedAt}`;
    const closure = resolveBoardClosure(registry, item);
    const event = { type: 'work_item.closed' as const, reason };
    const phase = closure ? (reason === 'completed' ? closure.completed : closure.canceled) : undefined;
    const result = await options.workItems.commitRuleEvaluation({
      orgId: target.orgId,
      factoryProjectId: target.factoryProjectId,
      workItemId: item.id,
      ingress: { identity, triggerType: `github.dependabot_alert.${alert.state}` },
      configVersion: options.configVersion,
      expectedRevision: item.revision,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [
        closure && phase
          ? {
              type: 'transition',
              idempotencyKey: `${identity}:transition`,
              board: board.id,
              stage: phase.phase,
              message: {
                text: `Dependabot alert ${alert.advisory} was ${alert.state === 'fixed' ? 'fixed' : 'dismissed'}; this ${closure.boardTitle} card was moved to ${phase.title}.`,
              },
              event,
            }
          : { type: 'routeEvent', idempotencyKey: `${identity}:route`, event },
      ],
      causalChain: [],
      now: now(),
    });
    if (result.status === 'stale') throw new Error(`Card ${item.id} changed while closing its Dependabot alert; retrying next sweep.`);
    return true;
  };

  const fileAlert = async (
    target: ExternalRepositoryProjectTarget,
    repository: ReconcileRepository,
    alert: DependabotAlert,
    routes: readonly IntakeRoute[],
    registry: BoardRegistry,
  ): Promise<Outcome> => {
    const scope = { orgId: target.orgId, factoryProjectId: target.factoryProjectId };
    const source = alertSource(repository, alert);
    const metadata = alertMetadata(repository, alert);
    const existing = await options.workItems.getByProjectSource({ ...scope, source });
    if (existing) {
      const current = { ...existing.workItem?.metadata, ...existing.metadata };
      let item = existing;
      let updated = false;
      if (!sameMetadata(current, metadata)) {
        await options.workItems.update({
          orgId: target.orgId,
          id: existing.id,
          userId: USER_ID,
          patch: { metadata: { ...current, ...metadata } },
        });
        item = (await options.workItems.getByProjectSource({ ...scope, source })) ?? existing;
        updated = true;
      }
      if (alert.state !== 'open' && (await closeCard(target, item, alert, registry))) return 'closed';
      return updated ? 'updated' : 'unchanged';
    }
    if (alert.state !== 'open') return 'unchanged';
    if (!routesSubscribeAlert(routes, alertFacts(repository, alert, metadata))) return 'unchanged';
    const landing = intakeTarget(registry);
    if (!landing) throw new Error(`Project ${target.factoryProjectId} has no board that takes new cards.`);
    // Alerts open before the server started never start work on their own: the first sweep would
    // otherwise launch an agent for every open alert in the repository.
    const fresh = Date.parse(alert.createdAt) > startedAt.getTime();
    const sourceKey = dependabotSourceKey(repository.id, alert.number);
    const identity = `github:dependabot:${sourceKey}:created`;
    const result = await options.workItems.commitRuleEvaluation({
      orgId: target.orgId,
      factoryProjectId: target.factoryProjectId,
      workItemId: null,
      ingress: { identity, triggerType: 'github.dependabot_alert.created' },
      configVersion: options.configVersion,
      expectedRevision: null,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [
        {
          type: 'upsertLinkedWorkItem',
          idempotencyKey: `${identity}:intake`,
          board: landing.board,
          source: 'github-dependabot-alert',
          sourceKey,
          title: alertTitle(alert),
          url: alert.url,
          stage: landing.initialPhase,
          routing: { skipCatchAll: true, ...(fresh ? {} : { holdAtInitialPhase: true }) },
          metadata,
        },
      ],
      causalChain: [],
      now: now(),
    });
    if (result.status === 'stale') throw new Error(`A card for Dependabot alert ${sourceKey} raced this sweep; retrying next sweep.`);
    return 'created';
  };

  /** The projects linking the repository that take its alerts now, with their routes and boards. */
  const interestedProjects = async (repository: ReconcileRepository) => {
    const targets = await options.projectRepositories.listByExternalRepository({
      installationExternalId: String(repository.installationId),
      repositoryExternalId: String(repository.id),
    });
    const interested: Array<{ target: ExternalRepositoryProjectTarget; routes: readonly IntakeRoute[] }> = [];
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.factoryProjectId)) continue;
      seen.add(target.factoryProjectId);
      const selection = (await options.intake.getConfig({ orgId: target.orgId, integrationIds: [DEPENDABOT_INTAKE_ID] }))[
        DEPENDABOT_INTAKE_ID
      ];
      if (!selection?.enabled) continue;
      const routes = await options.intakeRoutes.listIntakeRoutes({
        orgId: target.orgId,
        factoryProjectId: target.factoryProjectId,
      });
      if (!routesSubscribeAlert(routes)) continue;
      interested.push({ target, routes });
    }
    return interested;
  };

  return async (repositories: ReconcileRepository[]): Promise<DependabotSweepSummary> => {
    const summary: DependabotSweepSummary = {
      repositories: 0,
      checked: 0,
      created: 0,
      updated: 0,
      closed: 0,
      failed: 0,
      errors: [],
    };
    for (const repository of repositories) {
      let interested: Awaited<ReturnType<typeof interestedProjects>>;
      try {
        interested = await interestedProjects(repository);
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ repository: repository.fullName, error: errorMessage(error) });
        continue;
      }
      if (interested.length === 0) continue;
      summary.repositories += 1;
      const orgs = [...new Set(interested.map(({ target }) => target.orgId))];
      const checkedAt = now().toISOString();
      let alerts: DependabotAlert[];
      try {
        const [open, closed] = await Promise.all([
          options.listAlerts({ installationId: repository.installationId, repository: repository.fullName, state: 'open' }),
          options.listAlerts({ installationId: repository.installationId, repository: repository.fullName, state: 'closed' }),
        ]);
        alerts = [...open, ...closed];
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ repository: repository.fullName, error: errorMessage(error) });
        const problem = error instanceof DependabotAccessError ? error.problem : 'error';
        for (const orgId of orgs) {
          options.status.record(orgId, { repository: repository.fullName, checkedAt, problem, message: errorMessage(error) });
        }
        continue;
      }
      for (const orgId of orgs) {
        options.status.record(orgId, {
          repository: repository.fullName,
          checkedAt,
          openAlerts: alerts.filter(alert => alert.state === 'open').length,
        });
      }
      for (const { target, routes } of interested) {
        const registry = await options.projectBoards.load({ orgId: target.orgId, factoryProjectId: target.factoryProjectId });
        for (const alert of alerts) {
          summary.checked += 1;
          try {
            const outcome = await fileAlert(target, repository, alert, routes, registry);
            if (outcome !== 'unchanged') summary[outcome] += 1;
          } catch (error) {
            summary.failed += 1;
            summary.errors.push({ repository: repository.fullName, alert: alert.number, error: errorMessage(error) });
          }
        }
      }
    }
    return summary;
  };
}

/** GitHub's alert JSON, as much of it as the sweep reads. */
interface GithubAlertPayload {
  number: number;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  dependency?: { package?: { ecosystem?: string; name?: string }; manifest_path?: string | null } | null;
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    description?: string;
    severity?: string;
  } | null;
  security_vulnerability?: { severity?: string; first_patched_version?: { identifier?: string } | null } | null;
}

const ALERT_STATES = new Set<DependabotAlertState>(['open', 'fixed', 'dismissed', 'auto_dismissed']);

/** An alert from GitHub's REST payload (`GET /repos/{owner}/{repo}/dependabot/alerts`, and the webhook's `alert`). */
export function parseDependabotAlert(payload: unknown): DependabotAlert | undefined {
  const raw = payload as GithubAlertPayload | null;
  if (!raw || typeof raw.number !== 'number' || typeof raw.html_url !== 'string') return undefined;
  if (!ALERT_STATES.has(raw.state as DependabotAlertState)) return undefined;
  const advisory = raw.security_advisory ?? {};
  return {
    number: raw.number,
    state: raw.state as DependabotAlertState,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    severity: (raw.security_vulnerability?.severity ?? advisory.severity ?? 'unknown').toLowerCase(),
    ecosystem: raw.dependency?.package?.ecosystem ?? 'unknown',
    package: raw.dependency?.package?.name ?? 'unknown package',
    manifestPath: raw.dependency?.manifest_path ?? null,
    advisory: advisory.ghsa_id ?? `alert ${raw.number}`,
    cve: advisory.cve_id ?? null,
    summary: advisory.summary ?? '',
    description: advisory.description ?? '',
    fixedIn: raw.security_vulnerability?.first_patched_version?.identifier ?? null,
  };
}

/**
 * Turns GitHub's refusal into a {@link DependabotAccessError}, or returns the error as it was. A
 * 403 is the missing "Dependabot alerts: read" permission unless GitHub says the repository has
 * alerts switched off; a 404 is a repository the connection can't see.
 */
export function dependabotAccessError(error: unknown, repository: string): unknown {
  const status = (error as { status?: unknown } | null)?.status;
  const message = errorMessage(error);
  if (status === 403 && /disabled/i.test(message)) {
    return new DependabotAccessError('disabled', `Dependabot alerts are switched off for ${repository}.`);
  }
  if (status === 403) {
    return new DependabotAccessError(
      'permission',
      `The GitHub connection can't read Dependabot alerts of ${repository}: give it the "Dependabot alerts: read" permission (a fine-grained token or the App's repository permissions).`,
    );
  }
  if (status === 404) {
    return new DependabotAccessError('not_found', `The GitHub connection can't see ${repository}, or its Dependabot alerts.`);
  }
  return error;
}
