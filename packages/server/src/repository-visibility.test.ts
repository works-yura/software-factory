import { describe, expect, it, vi } from 'vitest';

import { githubRepositorySlug, githubRepositoryVisibility } from './repository-visibility.ts';

describe('repository visibility from GitHub', () => {
  it('reads `private` of a github.com repository with the repository token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ private: true }), { status: 200 }));
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://github.com/Acme/App.git', authorization: { token: 't' } }, fetchImpl as never)).toBe('private');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/Acme/App', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }));
    const open = vi.fn(async () => new Response(JSON.stringify({ private: false }), { status: 200 }));
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://github.com/acme/site', authorization: { token: 't' } }, open as never)).toBe('public');
  });

  it('is unknown for another host, without a token, or when GitHub does not answer', async () => {
    const never = vi.fn();
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://gitlab.com/acme/app.git', authorization: { token: 't' } }, never as never)).toBe('unknown');
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://github.com/acme/app.git' }, never as never)).toBe('unknown');
    expect(never).not.toHaveBeenCalled();
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://github.com/acme/app.git', authorization: { token: 't' } }, failing as never)).toBe('unknown');
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await githubRepositoryVisibility({ cloneUrl: 'https://github.com/acme/app.git', authorization: { token: 't' } }, throwing as never)).toBe('unknown');
    expect(githubRepositorySlug('https://github.com/a/b/c')).toBeUndefined();
  });
});
