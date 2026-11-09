import { FactorySandbox } from '@mastra/core/workspace';
import type { MastraSandbox } from '@mastra/core/workspace';

import type { FactoryWorkspaceSandboxContext } from './local-factory-sandbox.ts';
import type { MastraFactorySandboxConfig } from './session-sandbox.ts';

/**
 * Wraps the `sandbox: ctx => new SomeSandbox(...)` host callback
 * as a FactorySandbox. The host owns everything inside the callback, so the
 * factory knows nothing about it: no settings, no template, no builds.
 */
export class CallbackFactorySandbox extends FactorySandbox<Record<string, never>> {
  readonly provider = 'custom';

  readonly #callback: MastraFactorySandboxConfig;

  constructor(callback: MastraFactorySandboxConfig) {
    super();
    this.#callback = callback;
  }

  /** The callback receives the card folder too (`workItemFolder`); sharing it across sessions is the host's call. */
  create(ctx: FactoryWorkspaceSandboxContext): MastraSandbox {
    return this.#callback(ctx);
  }
}
