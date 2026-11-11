// Asks the installed CLI what it offers: its version, whether it is signed in (`codex login`), and
// its models (`model/list`, every page). Spawns `codex app-server` for the questions and stops it.
import type { ServerProviderModel } from '@factory/harness/models/contracts';

import { spawnCodexAppServer, type CodexSpawn } from '../protocol/client.ts';
import type { CodexAppServerClient } from '../protocol/client.ts';
import type { CodexAccount, GetAccountResponse } from '../protocol/schema.ts';
import { parseCodexModelListResponse } from './codexModelCatalog.ts';

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

export interface CodexProbeInput {
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly spawn?: CodexSpawn;
  readonly timeoutMs?: number;
}

export interface CodexProbeResult {
  readonly version: string | undefined;
  readonly account: CodexAccount | null;
  /** No account and the CLI needs one: `codex login` first. */
  readonly needsLogin: boolean;
  /** Empty when the CLI needs a login. */
  readonly models: ServerProviderModel[];
}

/** Every page of `model/list`. */
export async function requestAllCodexModels(client: CodexAppServerClient): Promise<ServerProviderModel[]> {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await client.request('model/list', cursor ? { cursor } : {});
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);
  return models;
}

export function codexNeedsLogin(account: GetAccountResponse): boolean {
  return !account.account && account.requiresOpenaiAuth;
}

/** How a person reads the account a Codex probe found. */
export function codexAccountLabel(account: CodexAccount | null): string | undefined {
  if (!account) return undefined;
  if (account.type === 'apiKey') return 'OpenAI API Key';
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock';
  return codexPlanLabel(account.planType);
}

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case 'free':
      return 'ChatGPT Free Subscription';
    case 'go':
      return 'ChatGPT Go Subscription';
    case 'plus':
      return 'ChatGPT Plus Subscription';
    case 'pro':
      return 'ChatGPT Pro 200 Subscription';
    case 'prolite':
      return 'ChatGPT Pro 100 Subscription';
    case 'promax':
      return 'ChatGPT Pro 500 Subscription';
    case 'self_serve_business_prolite':
      return 'ChatGPT Business Premium Subscription';
    case 'team':
    case 'self_serve_business_usage_based':
    case 'business':
      return 'ChatGPT Business Subscription';
    case 'ent26':
    case 'enterprise_cbp_automation':
    case 'enterprise_cbp_usage_based':
    case 'enterprise':
      return 'ChatGPT Enterprise Subscription';
    case 'edu':
    case 'edu_plus':
    case 'edu_pro':
      return 'ChatGPT Edu Subscription';
    case 'unknown':
      return 'ChatGPT Subscription';
    default:
      return undefined;
  }
}

/** Probes the CLI; throws when it cannot start or does not answer in time. */
export async function probeCodex(input: CodexProbeInput): Promise<CodexProbeResult> {
  const server = await spawnCodexAppServer({
    ...(input.command ? { command: input.command } : {}),
    ...(input.args ? { args: input.args } : {}),
    cwd: input.cwd,
    env: input.env,
    ...(input.spawn ? { spawn: input.spawn } : {}),
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex did not answer in time.')), input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      (async (): Promise<CodexProbeResult> => {
        const account = await server.client.request('account/read', {});
        if (codexNeedsLogin(account)) return { version: server.version, account: null, needsLogin: true, models: [] };
        const models = await requestAllCodexModels(server.client);
        return { version: server.version, account: account.account, needsLogin: false, models };
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    server.terminate();
  }
}
