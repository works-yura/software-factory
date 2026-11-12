import { EXISTING_ORGANIZATION_ID } from '@factory/auth';
import type { FactoryIntegration } from '@factory/integrations';
import {
  AUDITS_LEGACY_PHASE_RENAMES,
  auditsBoard,
  PRODUCT_LEGACY_PHASE_RENAMES,
  productBoard,
} from '@factory/pipelines';
import type { ProjectBoardCache } from '@factory/runtime';
import {
  boardDefinitionOf,
  migrateLabelRoutesToIntakeRoutes,
  PRODUCT_BOARD_UPGRADE_ACTOR,
  REVIEW_BOARD_RETIREMENT_ACTOR,
} from '@factory/store';
import type {
  FactoryProjectsStorage,
  IntakeRouteFiresStorage,
  IntakeStorage,
  IntegrationStorage,
  McpServersStorage,
  SourceControlStorage,
  StoredBoardsStorage,
  WorkItemsStorage,
} from '@factory/store';

import { migrateCanonicalRoutes } from '../intake/canonical-routes.ts';
import { AUDITS_BOARD_UPGRADE_ACTOR, migrateLegacyIntakeRules } from '../intake/migrations.ts';
import { migrateGithubRepositorySelections, migrateGitLabProjectSelections } from '../intake/repository-subscriptions.ts';
import { presetToCatalogLaunch } from '../mcp-servers/migrations.ts';
import type { BootMigration } from './run.ts';

export interface FactoryMigrationDeps {
  ready(domain: string): boolean;
  intake: IntakeStorage;
  boards: StoredBoardsStorage;
  workItems: WorkItemsStorage;
  fires: IntakeRouteFiresStorage;
  projects: FactoryProjectsStorage;
  integrationStorage: IntegrationStorage;
  sourceControl: SourceControlStorage;
  projectBoards: ProjectBoardCache | undefined;
  integrations: readonly FactoryIntegration[];
  mcpServers: Pick<McpServersStorage, 'rewriteLaunches'>;
  /** Integration env vars the entry still found set (`CLICKUP_API_TOKEN`, …), for the one-time move into an organization. */
  retiredIntegrationEnv: Readonly<Record<string, string>>;
}

const LABEL_ROUTE_NAMES = [
  ['clickup', (label: string) => `ClickUp tag "${label}"`],
  ['github', (label: string) => `GitHub label "${label}"`],
  ['gitlab', (label: string) => `GitLab label "${label}"`],
] as const;

/**
 * Every one-off boot migration, in the order they run. Append new ones at the end with a new id;
 * never edit a finished one in place (its marker would hide the change).
 */
export function factoryBootMigrations(deps: FactoryMigrationDeps): BootMigration[] {
  const { ready, intake, boards, workItems, fires, projectBoards } = deps;
  return [
    // Label routes (ClickUp tags, GitHub and GitLab labels) became intake routes: nothing reads
    // label routes any more, so a failure stops the boot.
    ...LABEL_ROUTE_NAMES.map(
      ([integrationId, routeName]): BootMigration => ({
        id: `intake.labelRoutes.${integrationId}.v1`,
        ready: ready('intake') && ready('boards'),
        onFailure: 'stop-boot',
        run: async () => {
          const moved = await migrateLabelRoutesToIntakeRoutes({ integrationId, routeName, intake, boards });
          return moved > 0 ? `moved ${moved} ${integrationId} label route(s) into intake routes` : undefined;
        },
      }),
    ),
    // The Review board was retired: pull and merge requests are reviewed in Work › PR review. Its
    // cards, routes and sources move to Work; anything left would point at a board that's gone.
    {
      id: 'workItems.retireReviewBoard.v1',
      ready: ready('work-items'),
      onFailure: 'stop-boot',
      run: async () => {
        const moved = await workItems.moveReviewBoardCardsToWork();
        return moved.length > 0 ? `moved ${moved.length} Review board card(s) to Work › PR review` : undefined;
      },
    },
    {
      id: 'boards.retireReviewBoardRoutes.v1',
      ready: ready('boards'),
      onFailure: 'stop-boot',
      run: async () => {
        const moved = await boards.moveReviewBoardRoutesToWork(REVIEW_BOARD_RETIREMENT_ACTOR);
        return moved > 0 ? `moved ${moved} intake route(s) from the Review board to Work` : undefined;
      },
    },
    {
      id: 'intake.retireReviewBoardSources.v1',
      ready: ready('intake'),
      onFailure: 'stop-boot',
      run: async () => {
        const { bindings, labelRoutes } = await intake.moveReviewBoardSourcesToWork();
        return bindings + labelRoutes > 0
          ? `moved ${bindings} intake source(s) and ${labelRoutes} label route(s) from the Review board to Work`
          : undefined;
      },
    },
    // Product's Breakdown became Phases, with Enrich and Design added: stored boards, cards and
    // routes move off the old phase names (cards in a phase the board lacks would be stranded).
    {
      id: 'boards.productPhases.v1',
      ready: ready('boards'),
      onFailure: 'stop-boot',
      run: async () => {
        const rewritten = await boards.renameStoredBoardPhases(
          productBoard.id,
          boardDefinitionOf(productBoard),
          PRODUCT_LEGACY_PHASE_RENAMES,
          PRODUCT_BOARD_UPGRADE_ACTOR,
        );
        return rewritten > 0 ? `rewrote ${rewritten} stored Product board(s) with the new phases` : undefined;
      },
    },
    {
      id: 'workItems.productPhases.v1',
      ready: ready('work-items'),
      onFailure: 'stop-boot',
      run: async () => {
        const moved = await workItems.renameBoardStages(productBoard.id, PRODUCT_LEGACY_PHASE_RENAMES);
        return moved.length > 0 ? `moved ${moved.length} Product card(s) off Breakdown to Phases` : undefined;
      },
    },
    // Audits starts in Intake like every board, and Done means the report is written.
    {
      id: 'boards.auditsPhases.v1',
      ready: ready('boards'),
      onFailure: 'stop-boot',
      run: async () => {
        const rewritten = await boards.renameStoredBoardPhases(
          auditsBoard.id,
          boardDefinitionOf(auditsBoard),
          AUDITS_LEGACY_PHASE_RENAMES,
          AUDITS_BOARD_UPGRADE_ACTOR,
        );
        return rewritten > 0 ? `rewrote ${rewritten} stored Audits board(s) with the new phases` : undefined;
      },
    },
    {
      id: 'workItems.auditsPhases.v1',
      ready: ready('work-items'),
      onFailure: 'stop-boot',
      run: async () => {
        const moved = await workItems.renameBoardStages(auditsBoard.id, AUDITS_LEGACY_PHASE_RENAMES);
        return moved.length > 0 ? `moved ${moved.length} Audits card(s) off Scheduled/Report` : undefined;
      },
    },
    // Intake rules made cards before routes could (ADR-0021): each becomes a route «За розкладом».
    // Before any trigger is armed; a half-moved rule would fire twice or not at all.
    {
      id: 'intake.legacyRules.v1',
      ready: ready('intake-route-fires') && ready('boards'),
      onFailure: 'stop-boot',
      run: async () => {
        const { migrated, removedRoutes } = await migrateLegacyIntakeRules({
          fires,
          boards,
          renames: { [auditsBoard.id]: AUDITS_LEGACY_PHASE_RENAMES },
        });
        return migrated + removedRoutes > 0
          ? `turned ${migrated} intake rule(s) into routes «За розкладом»; removed ${removedRoutes} paired route(s)`
          : undefined;
      },
    },
    // Triage no longer holds a non-bug in Triage until someone accepts it; it sends it back to
    // Intake. Nothing depends on the leftovers moving, so a failure only warns.
    {
      id: 'workItems.heldTriageCards.v1',
      ready: ready('work-items'),
      onFailure: 'warn',
      run: async () => {
        const moved = await workItems.returnHeldTriageCards();
        return moved.length > 0 ? `moved ${moved.length} card(s) held for triage acceptance back to Intake` : undefined;
      },
    },
    // Routes are the one subscription model (ADR-0022): the org-wide GitHub intake selection becomes
    // one route per selected linked repository, so each project reads what it read before. Nothing
    // reads the selection any more, so a failure stops the boot.
    {
      id: 'intake.githubRepositorySelections.v1',
      ready: ready('intake') && ready('boards') && ready('source-control') && ready('projects'),
      onFailure: 'stop-boot',
      run: async () => {
        const { routes } = await migrateGithubRepositorySelections({
          projects: deps.projects,
          intake,
          sourceControl: deps.sourceControl.forIntegration('github'),
          boards,
        });
        return routes > 0 ? `turned the GitHub intake selection into ${routes} repository route(s)` : undefined;
      },
    },
    // The same for GitLab: a selected project bound to a Factory project, and linked to it, becomes a
    // route on its path. Nothing reads the selection or the bindings for GitLab any more.
    {
      id: 'intake.gitlabProjectSelections.v1',
      ready: ready('intake') && ready('boards') && ready('source-control') && ready('projects'),
      onFailure: 'stop-boot',
      run: async () => {
        const { routes } = await migrateGitLabProjectSelections({
          projects: deps.projects,
          intake,
          sourceControl: deps.sourceControl.forIntegration('gitlab'),
          boards,
        });
        return routes > 0 ? `turned the GitLab intake selection into ${routes} project route(s)` : undefined;
      },
    },
    // Every stored route in the one-source form the editor reads: a set of repository hosts (or a
    // host-only condition with no source named) names the hosts the project links repositories from.
    // After the selections above, so their routes are already in place. A failure stops the boot:
    // the editor no longer infers a route's source.
    {
      id: 'intake.canonicalRoutes.v1',
      ready: ready('boards') && ready('source-control') && ready('projects'),
      onFailure: 'stop-boot',
      run: async () => {
        const { rewritten, added } = await migrateCanonicalRoutes({
          projects: deps.projects,
          sourceControl: deps.sourceControl,
          boards,
        });
        return rewritten + added > 0
          ? `named the source of ${rewritten} intake route(s)${added > 0 ? `, split into ${added} more` : ''}`
          : undefined;
      },
    },
    // MCP servers saved with the first version's built-in presets become catalog launches (MCP
    // Registry `server.json` entries). The launcher no longer knows presets, so a failure stops the boot.
    {
      id: 'mcpServers.presetsToCatalog.v1',
      ready: ready('mcp-servers'),
      onFailure: 'stop-boot',
      run: async () => {
        const moved = await deps.mcpServers.rewriteLaunches(presetToCatalogLaunch);
        return moved > 0 ? `moved ${moved} MCP server(s) from presets to the catalog` : undefined;
      },
    },
    // Integration-owned data (ClickUp's retired List status rules → intake routes), before any worker
    // reads. An integration whose migration fails is off for this boot rather than running on
    // half-migrated data.
    ...deps.integrations
      .filter(integration => integration.migrate)
      .map(
        (integration): BootMigration => ({
          id: `integration.${integration.id}.v1`,
          ready: Boolean(projectBoards) && ready('integrations') && ready('intake'),
          onFailure: 'disable-integration',
          integrationId: integration.id,
          run: async () => {
            await integration.migrate!({
              storage: deps.integrationStorage.forIntegration(integration.id),
              projects: deps.projects,
              intake,
              intakeRoutes: boards,
              projectBoards: projectBoards!,
            });
            return undefined;
          },
        }),
      ),
    // Integration tokens belong to organizations, not the deployment (ADR-0032): a token still in the
    // env moves into the organization that owned all data before organizations existed, unless it
    // already stored one (never overwritten). After this ran, nothing reads the env var.
    ...deps.integrations
      .filter(integration => integration.adoptDeploymentToken)
      .map(
        (integration): BootMigration => ({
          id: `integrations.envTokensToOrg.${integration.id}.v1`,
          ready: ready('integrations'),
          onFailure: 'disable-integration',
          integrationId: integration.id,
          run: () =>
            integration.adoptDeploymentToken!({
              storage: deps.integrationStorage.forIntegration(integration.id),
              orgId: EXISTING_ORGANIZATION_ID,
              env: deps.retiredIntegrationEnv,
            }),
        }),
      ),
  ];
}
