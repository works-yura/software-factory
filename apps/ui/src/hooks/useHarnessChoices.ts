import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';

import { useModelCatalogQuery } from './useAvailableModels';
import { useServerFeatures } from './useServerFeatures';

/** One harness the server runs, and whether this person can run a session on it (ADR-0036). */
export interface HarnessChoice {
  descriptor: HarnessDescriptor;
  /** Offered: it needs no connection, or the person has one it can run on. */
  usable: boolean;
  /** Why not, in the server's words. */
  reason?: string;
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
    const usable = !connector || instance === undefined || instance.available;
    return {
      descriptor,
      usable,
      ...(connector ? { connector } : {}),
      ...(!usable && instance?.reason ? { reason: instance.reason } : {}),
      ...(instance ? { instance } : {}),
    };
  });
  return { choices, isPending: features.isPending || catalog.isPending };
}
