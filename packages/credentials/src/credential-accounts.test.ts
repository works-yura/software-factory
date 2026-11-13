import { describe, expect, it } from 'vitest';

import type { CredentialAccount } from '@factory/store';

import { pickCredentialAccount } from './credential-accounts.ts';

const now = new Date('2026-10-28T12:00:00Z');
let created = 0;

function account(id: string, overrides: Partial<CredentialAccount> = {}): CredentialAccount {
  created += 1;
  return {
    id,
    orgId: 'org1',
    provider: 'anthropic',
    label: id,
    kind: 'api_key',
    priority: 0,
    disabled: false,
    factoryRuns: false,
    hint: '0000',
    createdBy: 'admin',
    createdAt: new Date(now.getTime() - 1_000_000 + created),
    updatedAt: now,
    ...overrides,
  };
}

const ids = (picked: ReturnType<typeof pickCredentialAccount>) => picked.account?.id;

describe('pickCredentialAccount', () => {
  it('never gives one person’s subscription to another person’s run', () => {
    const accounts = [account('alice-max', { kind: 'subscription', ownerUserId: 'alice' })];
    expect(ids(pickCredentialAccount(accounts, { userId: 'alice', now }))).toBe('alice-max');
    expect(pickCredentialAccount(accounts, { userId: 'bob', now })).toEqual({ hasCandidates: false });
  });

  it('prefers the session’s last account, then the person’s own subscription, then organization keys', () => {
    const accounts = [
      account('org-key', { priority: -5 }),
      account('alice-max', { kind: 'subscription', ownerUserId: 'alice', priority: 3 }),
      account('alice-pro', { kind: 'subscription', ownerUserId: 'alice', priority: 1 }),
    ];
    expect(ids(pickCredentialAccount(accounts, { userId: 'alice', now }))).toBe('alice-pro');
    expect(ids(pickCredentialAccount(accounts, { userId: 'alice', preferredId: 'org-key', now }))).toBe('org-key');
    expect(ids(pickCredentialAccount(accounts, { userId: 'bob', now }))).toBe('org-key');
  });

  it('treats a Claude sign-in like a subscription: its owner’s alone, ahead of organization keys', () => {
    const accounts = [account('team-key'), account('alice-login', { kind: 'claude_login', ownerUserId: 'alice' })];
    expect(ids(pickCredentialAccount(accounts, { userId: 'alice', now }))).toBe('alice-login');
    expect(ids(pickCredentialAccount(accounts, { userId: 'bob', now }))).toBe('team-key');
  });

  it('orders equal accounts by priority, then age', () => {
    const accounts = [account('b', { priority: 2 }), account('c', { priority: 1 }), account('d', { priority: 1 })];
    expect(ids(pickCredentialAccount(accounts, { userId: 'u', now }))).toBe('c');
    expect(ids(pickCredentialAccount(accounts, { userId: 'u', exclude: ['c'], now }))).toBe('d');
  });

  it('skips disabled, tried and limited accounts; a limit in the past no longer counts', () => {
    const accounts = [
      account('off', { disabled: true }),
      account('tried'),
      account('limited', { limitedUntil: new Date(now.getTime() + 60_000) }),
      account('recovered', { limitedUntil: new Date(now.getTime() - 1) }),
    ];
    expect(ids(pickCredentialAccount(accounts, { userId: 'u', exclude: ['tried'], now }))).toBe('recovered');
  });

  it('a preferred account that is limited does not win', () => {
    const accounts = [account('a', { limitedUntil: new Date(now.getTime() + 60_000) }), account('b')];
    expect(ids(pickCredentialAccount(accounts, { userId: 'u', preferredId: 'a', now }))).toBe('b');
  });

  it('reports the earliest reset when every account is out of usage, tried ones included', () => {
    const soon = new Date(now.getTime() + 60_000);
    const later = new Date(now.getTime() + 3_600_000);
    const accounts = [account('a', { limitedUntil: later }), account('b', { limitedUntil: soon })];
    expect(pickCredentialAccount(accounts, { userId: 'u', exclude: ['b'], now })).toEqual({
      hasCandidates: true,
      resetsAt: soon,
    });
  });

  it('reports no candidates when nothing is usable at all', () => {
    expect(pickCredentialAccount([], { userId: 'u', now })).toEqual({ hasCandidates: false });
    expect(pickCredentialAccount([account('off', { disabled: true })], { userId: 'u', now })).toEqual({
      hasCandidates: false,
    });
  });

  // A card's run belongs to the Factory: it never borrows a person's sign-in on its own.
  it("gives the Factory's runs only the sign-ins shared with them, and the organization's keys", () => {
    const factory = 'factory-project:fp-1';
    const personal = account('personal', { kind: 'claude_login', ownerUserId: 'alice' });
    expect(pickCredentialAccount([personal], { userId: factory, now })).toEqual({ hasCandidates: false });
    const shared = account('shared', { kind: 'claude_login', ownerUserId: 'bob', factoryRuns: true });
    expect(ids(pickCredentialAccount([personal, shared], { userId: factory, now }))).toBe('shared');
    expect(ids(pickCredentialAccount([personal, account('key')], { userId: factory, now }))).toBe('key');
  });
});
