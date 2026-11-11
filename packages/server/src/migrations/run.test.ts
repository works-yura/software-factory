import { describe, expect, it, vi } from 'vitest';

import type { BootMigration } from './run.ts';
import { runBootMigrations } from './run.ts';

function markersFrom(done: string[] = []) {
  const completed = new Set(done);
  return {
    completed: async () => new Set(completed),
    markCompleted: vi.fn(async (id: string) => {
      completed.add(id);
    }),
    done: completed,
  };
}

function migration(id: string, overrides: Partial<BootMigration> = {}): BootMigration & { calls: number } {
  const result = {
    id,
    ready: true,
    onFailure: 'stop-boot' as const,
    calls: 0,
    run: async () => {
      result.calls += 1;
      return undefined;
    },
    ...overrides,
  };
  return result;
}

describe('runBootMigrations', () => {
  it('runs each ready migration once, in order, and skips the finished ones on later boots', async () => {
    const order: string[] = [];
    const first = migration('a.v1', { run: async () => (order.push('a'), undefined) });
    const second = migration('b.v1', { run: async () => (order.push('b'), undefined) });
    const markers = markersFrom();

    await runBootMigrations([first, second], { markers });
    await runBootMigrations([first, second], { markers });

    expect(order).toEqual(['a', 'b']);
    expect(markers.done).toEqual(new Set(['a.v1', 'b.v1']));
  });

  it('leaves a migration whose storage is not up for a later boot', async () => {
    const waiting = migration('waiting.v1', { ready: false });
    const markers = markersFrom();

    await runBootMigrations([waiting], { markers });

    expect(waiting.calls).toBe(0);
    expect(markers.done.size).toBe(0);
  });

  it('stops the boot when a stop-boot migration fails, and does not mark it', async () => {
    const markers = markersFrom();
    const broken = migration('broken.v1', {
      run: async () => {
        throw new Error('disk full');
      },
    });

    await expect(runBootMigrations([broken], { markers })).rejects.toThrow('Boot migration "broken.v1" failed: disk full');
    expect(markers.done.size).toBe(0);
  });

  it('turns off only the integration whose migration failed, and retries it next boot', async () => {
    const markers = markersFrom();
    let fail = true;
    const clickup = migration('integration.clickup.v1', {
      onFailure: 'disable-integration',
      integrationId: 'clickup',
      run: async () => {
        if (fail) throw new Error('rate limited');
        return undefined;
      },
    });
    const after = migration('after.v1');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runBootMigrations([clickup, after], { markers });
    fail = false;
    const second = await runBootMigrations([clickup, after], { markers });

    expect(first.disabledIntegrations).toEqual(new Set(['clickup']));
    expect(after.calls).toBe(1);
    expect(second.disabledIntegrations.size).toBe(0);
    expect(second.ran).toEqual(['integration.clickup.v1']);
  });

  it('only warns for a migration nothing depends on, and retries it', async () => {
    const markers = markersFrom();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const optional = migration('optional.v1', {
      onFailure: 'warn',
      run: async () => {
        throw new Error('busy');
      },
    });

    const result = await runBootMigrations([optional], { markers });

    expect(result.ran).toEqual([]);
    expect(markers.done.size).toBe(0);
  });

  it('runs every ready migration when markers are unavailable (each is idempotent)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const once = migration('once.v1');

    await runBootMigrations([once], {});
    await runBootMigrations([once], {});

    expect(once.calls).toBe(2);
  });

  it('refuses a list that uses an id twice', async () => {
    await expect(runBootMigrations([migration('dup.v1'), migration('dup.v1')], {})).rejects.toThrow('used twice');
  });
});
