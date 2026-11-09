import { LibSQLFactoryStorage } from '@mastra/libsql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFactorySecretEncryption } from '@factory/store';
import { createTestBoard } from '@factory/pipelines/testing';
import { MastraFactory } from '../factory.ts';

// The warning is once per process, and each test file runs in its own module scope, so the order
// of these tests is part of what they check.

const DEPRECATION =
  '[Factory] MastraFactory({ boards }) and defineBoard() are deprecated: boards live in the database, and each project stores these definitions once. Write board definitions into projects with factory.upsertBoard(), or manage them through the boards API (`/web/factory/projects/:id/boards`).';

function construct(config: Partial<ConstructorParameters<typeof MastraFactory>[0]> = {}) {
  return new MastraFactory({
    storage: new LibSQLFactoryStorage({ id: 'deprecation', url: ':memory:' }),
    auth: null,
    secretEncryption: createFactorySecretEncryption({ primary: { id: 'test', key: Buffer.alloc(32, 7) } }),
    ...config,
  });
}

function deprecationWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]) => message === DEPRECATION);
}

describe('deprecating boards declared in code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says nothing for an app that only uses the built-in boards', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    construct();
    construct({ includeDefaultBoards: true });
    expect(deprecationWarnings(warn)).toEqual([]);
  });

  it('warns once per process for an app that passes its own boards', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    construct({ boards: [createTestBoard({ id: 'release' })] });
    construct({ boards: [createTestBoard({ id: 'hotfix' })] });
    expect(deprecationWarnings(warn)).toHaveLength(1);
  });
});
