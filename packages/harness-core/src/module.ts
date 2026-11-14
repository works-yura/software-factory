/**
 * A Factory harness module (ADR-0044): one harness as a Factory host plugs it in. The host keeps a
 * list of modules and goes through them for everything harness-shaped — which harnesses run, their
 * models, usage, accounts, parked sessions, session files, sign-in, extra routes and UI flags —
 * instead of naming harnesses. Adding a harness is one module and one line in that list.
 *
 * Generic over the host: the server instantiates it with its own config, boot and run dependencies
 * (`ServerHarnessModule` in `@factory/server`), so this package stays free of the server and the API.
 */
import type { HarnessDescriptor } from './descriptor.ts';
import type { HarnessModels } from './models/facet.ts';
import type { HarnessRoute } from './routing.ts';
import type { HarnessUsage } from './usage/facet.ts';

export interface FactoryHarnessModule<Config, Boot, Host, Running extends FactoryHarnessRunning = FactoryHarnessRunning> {
  /** What the UI is told about it; `descriptor.id` is the harness id Factories and sessions store. */
  readonly descriptor: HarnessDescriptor;
  /** The host config key that configures it; the harness runs only when the host config has it. */
  readonly configKey: string;
  /**
   * Boot, before any session exists: resolve its executable, read its accounts' allowances. What it
   * returns creates the running harness once the host's run dependencies exist.
   */
  prepare(config: Config, boot: Boot): PreparedFactoryHarness<Host, Running>;
}

export interface PreparedFactoryHarness<Host, Running extends FactoryHarnessRunning = FactoryHarnessRunning> {
  /** Its accounts' allowances (`./usage/facet.ts`), registered before the first turn so turns are observed. */
  readonly usage?: HarnessUsage;
  create(host: Host): Running;
}

/** What every running harness gives the host; the host's own type adds its optional facets. */
export interface FactoryHarnessRunning {
  readonly descriptor: HarnessDescriptor;
  /** For the routing harness: which sessions are this harness's. */
  readonly route: HarnessRoute;
  /** Its models, already wrapped with the availability the host checks (executable, connection). */
  readonly models: HarnessModels;
}
