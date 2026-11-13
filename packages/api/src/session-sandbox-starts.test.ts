import { describe, expect, it } from 'vitest';

import { MaterializeError } from '@factory/sandbox';

import { classifySessionSandboxStartError, NothingToStartError } from './session-sandbox-starts.ts';

describe('classifySessionSandboxStartError', () => {
  it.each([
    [new Error('Sandbox command timed out after 900s while cloning.'), 'timeout'],
    [
      new MaterializeError(
        'git clone failed: error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds',
        'clone-failed',
      ),
      'timeout',
    ],
    [
      new MaterializeError(
        'The sandbox could not reach github.com. The sandbox network must allow outbound egress to github.com.',
        'egress-blocked',
      ),
      'network',
    ],
    [new MaterializeError("git clone failed: remote: Repository not found.\nfatal: repository '…' not found", 'clone-failed'), 'no_access'],
    [new Error('git clone failed: fatal: Authentication failed for https://github.com/acme/app.git'), 'no_access'],
    [new MaterializeError('git clone failed: fatal: destination path exists and is not empty', 'clone-failed'), 'clone_failed'],
    [new NothingToStartError('This session has no sandbox to start.'), 'no_sandbox'],
    [new Error('setup failed'), 'unknown'],
  ])('sorts %s as %s, keeping its message', (error, code) => {
    expect(classifySessionSandboxStartError(error)).toEqual({ code, message: error.message });
  });
});
