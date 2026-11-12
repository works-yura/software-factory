import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import type { HarnessModelInstanceInfo, HarnessUnavailableCode } from '@factory/harness/models/facet';

import { harnessUnavailableReason } from './harnessUnavailableReason';

import { useModelCatalogQuery } from './useAvailableModels';
import { useServerFeatures } from './useServerFeatures';

/** One harness the server runs, and whether this person can run a session on it (ADR-0036). */
export interface HarnessChoice {
  descriptor: HarnessDescriptor;
  /** Offered: it needs no connection, or the person has one it can run on. */
  usable: boolean;
  /** Why not: in the viewer's language when the server named the cause (`reasonCode`), else in its words. */
  reason?: string;
  /** The cause the server named; `executable_missing` cannot be fixed by connecting an account. */
  reasonCode?: HarnessUnavailableCode;
  /** The connector that makes it usable (Settings › Підключення), when it runs on connections. */
  connector?: string;
  instance?: HarnessModelInstanceInfo;
}

/**
 * The harnesses this server runs (`/web/config/features` `harnesses`) beside their availability for
 * the viewer (`/web/config/models` `instances`): a harness whose sessions run on connections the
 * person lacks is not usable, and says where to connect one. Nothing here names a harness.
 */
export function useHarnessChoices(factoryProjectId?: string): { choices: HarnessChoice[]; isPending: boolean } {
  const features = useServerFeatures();
  const catalog = useModelCatalogQuery(factoryProjectId ? { factoryProjectId } : undefined);
  const instances = catalog.data?.instances ?? [];
  const choices = (features.data?.harnesses ?? []).map((descriptor): HarnessChoice => {
    const instance = instances.find(entry => entry.harnessId === descriptor.id);
    const connector = instance?.connector ?? descriptor.setup.accounts?.connector;
    // Without a connector the harness has its own setup (Mastra's providers): always offered.
    // A harness whose CLI is missing here is offered to nobody, connector or not (ADR-0038).
    const usable = instance?.reasonCode === 'executable_missing' ? false : !connector || instance === undefined || instance.available;
    const reason = !usable && instance ? harnessUnavailableReason(instance, descriptor.label) : undefined;
    return {
      descriptor,
      usable,
      ...(connector ? { connector } : {}),
      ...(reason ? { reason } : {}),
      ...(!usable && instance?.reasonCode ? { reasonCode: instance.reasonCode } : {}),
      ...(instance ? { instance } : {}),
    };
  });
  return { choices, isPending: features.isPending || catalog.isPending };
}
