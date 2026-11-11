/**
 * What every turn-based harness (Claude Code, Codex) shares about a Factory session, so a rule is
 * written once and each harness only maps it onto its CLI.
 */
import { CLAUDE_THREAD_SETTINGS } from './claude/start-coordinator.ts';

/** The thread settings a turn-based session carries (the start coordinator writes them, both harnesses read them). */
export const TURN_THREAD_SETTINGS = CLAUDE_THREAD_SETTINGS;

/**
 * The session's checkout is a pull or merge request someone outside wrote (the start coordinator
 * marks it, once and for good). Its repository config is attacker-writable, and both CLIs read
 * theirs from the cwd: such a session reads none of it. Claude Code reads no settings file
 * (`--setting-sources` empty: no `.claude/settings.json` hooks); Codex reads no project
 * instructions (`AGENTS.md`) and treats the checkout as an untrusted project (no `.codex/` config
 * layer, no project hooks), see {@link codexUntrustedCheckoutConfig}.
 */
export async function isUntrustedCheckout(thread: { getSetting(input: { key: string }): Promise<unknown> }): Promise<boolean> {
  return (await thread.getSetting({ key: TURN_THREAD_SETTINGS.untrustedCheckout })) === true;
}

/** Codex's thread config for an untrusted checkout at `cwd`: no `AGENTS.md`, and the project untrusted. */
export function codexUntrustedCheckoutConfig(cwd: string | undefined): Record<string, string | number | Record<string, Record<string, string>>> {
  return {
    project_doc_max_bytes: 0,
    ...(cwd ? { projects: { [cwd]: { trust_level: 'untrusted' } } } : {}),
  };
}
