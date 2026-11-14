/**
 * The harnesses this server knows (ADR-0044): the one list a new harness is added to. Order is the
 * order everything lists them in (`/web/config/features` → `harnesses`, Settings › Підключення,
 * model instances). Mastra, the base harness, comes first and always runs; a turn harness runs when
 * the server config has its `configKey`.
 */
import { MASTRA_HARNESS } from '@factory/contracts';

import { claudeCodeHarnessModule } from '../claude/module.ts';
import { codexHarnessModule } from '../codex/module.ts';
import { openCodeHarnessModule } from '../opencode/module.ts';
import type { BaseHarnessModule, HarnessConfigEnv, TurnHarnessModule } from './module.ts';

export const mastraHarnessModule: BaseHarnessModule = { kind: 'base', descriptor: MASTRA_HARNESS };

export const SERVER_HARNESS_MODULES = [mastraHarnessModule, claudeCodeHarnessModule, codexHarnessModule, openCodeHarnessModule] as const;

type BuiltInTurnModule = Extract<(typeof SERVER_HARNESS_MODULES)[number], { kind: 'turn' }>;
type ConfigOf<Module> = Module extends TurnHarnessModule<infer Config, string> ? Config : never;

/** Each turn harness's config under its `configKey` (`claudeCode`, `codex`, `opencode`): `MastraFactoryConfig` extends it. */
export type HarnessModuleConfigs = { [Module in BuiltInTurnModule as Module['configKey']]?: ConfigOf<Module> };

/** The turn harness modules of a list, in its order. */
export function turnHarnessModules(modules: ReadonlyArray<BaseHarnessModule | TurnHarnessModule<any, string>>): TurnHarnessModule<any, string>[] {
  return modules.filter((module): module is TurnHarnessModule<any, string> => module.kind === 'turn');
}

/**
 * Every built-in turn harness's config as the deployment's environment sets it (store dirs, CLI
 * commands, the agent user): what `apps/server` passes to `MastraFactory`.
 */
export function harnessConfigsFromEnv(context: HarnessConfigEnv): HarnessModuleConfigs {
  const configs: Record<string, unknown> = {};
  for (const module of turnHarnessModules(SERVER_HARNESS_MODULES)) {
    const config = module.configFromEnv?.(context);
    if (config !== undefined) configs[module.configKey] = config;
  }
  return configs as HarnessModuleConfigs;
}
