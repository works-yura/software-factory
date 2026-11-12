/**
 * Connectors loaded at boot from packages named in configuration (`FACTORY_CONNECTOR_PACKAGES`, a
 * comma-separated list of module specifiers or paths), beside the first-party ones registered in
 * code. Each package exports `connector`: a {@link ConnectorPackage} — its id, the contract version
 * it implements, and how to build its facet. A package that cannot be imported, exports something
 * else, names a taken id or another contract major does not stop the server: it is registered as a
 * failing connector, so Settings › Підключення names it in `failures` and serves the rest.
 */

import { CONNECTIONS_CONTRACT_VERSION, contractMajor } from '@factory/contracts';

import type { ConnectorRegistration, IntegrationConnections } from './connections.ts';

/** What a connector package gives the server. */
export interface ConnectorPackage {
  /** Its connector id: lowercase letters, digits and dashes; the prefix of its connections' ids. */
  id: string;
  /** The connections contract version it implements (`CONNECTIONS_CONTRACT_VERSION` it was built with). */
  contractVersion: string;
  create(context: ConnectorPackageContext): IntegrationConnections | Promise<IntegrationConnections>;
}

/** What the server hands a package: the environment it may read its own settings from. */
export interface ConnectorPackageContext {
  env: Readonly<Record<string, string | undefined>>;
}

export interface LoadedConnectorPackages {
  registrations: ConnectorRegistration[];
  /** Why each package that did not load did not, by its specifier (also served as a failing connector). */
  failures: Array<{ spec: string; id: string; message: string }>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The specifiers in `FACTORY_CONNECTOR_PACKAGES`. */
export function connectorPackageSpecs(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(spec => spec.trim())
    .filter(Boolean);
}

/** A connector whose every call fails with `message`: the registry isolates it and names it in `failures`. */
function failingConnector(message: string): IntegrationConnections {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    contractVersion: CONNECTIONS_CONTRACT_VERSION,
    describe: () => {
      throw new Error(message);
    },
    list: fail,
    connect: fail,
  };
}

function isPackage(value: unknown): value is ConnectorPackage {
  const candidate = value as Partial<ConnectorPackage> | undefined;
  return Boolean(candidate && typeof candidate.id === 'string' && typeof candidate.contractVersion === 'string' && typeof candidate.create === 'function');
}

function isFacet(value: unknown): value is IntegrationConnections {
  const facet = value as Partial<IntegrationConnections> | undefined;
  return Boolean(facet && typeof facet.describe === 'function' && typeof facet.list === 'function' && typeof facet.connect === 'function');
}

/** A placeholder id for a package that never said its own. */
const idOf = (spec: string) =>
  spec
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z]+$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'connector-package';

/**
 * Imports each package and builds its connector, checked against the contract. `reservedIds` are the
 * first-party connectors' ids, which a package may not take.
 */
export async function loadConnectorPackages(
  specs: readonly string[],
  options: { reservedIds?: readonly string[]; context?: ConnectorPackageContext; import?: (spec: string) => Promise<unknown> } = {},
): Promise<LoadedConnectorPackages> {
  const load = options.import ?? ((spec: string) => import(spec));
  const context = options.context ?? { env: process.env };
  const taken = new Set(options.reservedIds ?? []);
  const loaded: LoadedConnectorPackages = { registrations: [], failures: [] };
  const fail = (spec: string, id: string, message: string) => {
    console.warn(`[factory] connector package ${spec} was not loaded: ${message}`);
    loaded.failures.push({ spec, id, message });
    // A failing id that is taken would shadow the real connector; it stays only in the log then.
    if (!taken.has(id)) {
      taken.add(id);
      loaded.registrations.push({ id, connections: failingConnector(message) });
    }
  };
  for (const spec of specs) {
    let module: unknown;
    try {
      module = await load(spec);
    } catch (error) {
      fail(spec, idOf(spec), `could not be imported: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const exported = (module as { connector?: unknown; default?: unknown } | null)?.connector ?? (module as { default?: unknown } | null)?.default;
    if (!isPackage(exported)) {
      fail(spec, idOf(spec), 'exports no `connector` ({ id, contractVersion, create })');
      continue;
    }
    if (!ID.test(exported.id)) {
      fail(spec, idOf(spec), `its id ${JSON.stringify(exported.id)} is not lowercase letters, digits and dashes`);
      continue;
    }
    if (taken.has(exported.id)) {
      fail(spec, `${exported.id}-package`, `its id ${exported.id} is taken by another connector`);
      continue;
    }
    if (contractMajor(exported.contractVersion) !== contractMajor(CONNECTIONS_CONTRACT_VERSION)) {
      fail(spec, exported.id, `built for connections contract ${exported.contractVersion}; this server speaks ${CONNECTIONS_CONTRACT_VERSION}`);
      continue;
    }
    try {
      const facet = await exported.create(context);
      if (!isFacet(facet)) {
        fail(spec, exported.id, 'create() returned no connections facet (describe, list, connect)');
        continue;
      }
      taken.add(exported.id);
      loaded.registrations.push({ id: exported.id, connections: { ...bind(facet), contractVersion: exported.contractVersion } });
    } catch (error) {
      fail(spec, exported.id, `create() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return loaded;
}

/** The facet's members bound to it, so a class instance keeps its `this` once spread. */
function bind(facet: IntegrationConnections): IntegrationConnections {
  const bound: Record<string, unknown> = {};
  let proto: object | null = facet;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key in bound) continue;
      const value = (facet as unknown as Record<string, unknown>)[key];
      bound[key] = typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(facet) : value;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return bound as unknown as IntegrationConnections;
}
