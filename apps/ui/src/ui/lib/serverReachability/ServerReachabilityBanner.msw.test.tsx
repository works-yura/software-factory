import { onlineManager } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerReachabilityBanner } from './ServerReachabilityBanner';
import { bindOnlineManager, ServerReachability } from './serverReachability';

function reachabilityWith(health: () => Promise<Response>) {
  return new ServerReachability({ fetchImpl: vi.fn(health) });
}

const up = () => Promise.resolve(new Response('{}', { status: 200 }));
const gone = () => Promise.reject(new TypeError('Failed to fetch'));

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ServerReachabilityBanner', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('renders nothing while the server answers', () => {
    const { container } = render(<ServerReachabilityBanner reachability={reachabilityWith(up)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the restart banner while down and the "back" note once /health answers', async () => {
    let healthy = false;
    const reachability = reachabilityWith(() => (healthy ? up() : gone()));
    render(<ServerReachabilityBanner reachability={reachability} />);

    reachability.requestFailed();
    await settle();
    expect(await screen.findByText(/not responding/i)).toBeInTheDocument();

    healthy = true;
    await userEvent.click(screen.getByRole('button', { name: /try now/i }));
    await settle();
    expect(await screen.findByText(/server is back/i)).toBeInTheDocument();
  });

  it('takes TanStack Query offline while the server is down, and back online after', async () => {
    let healthy = false;
    const reachability = reachabilityWith(() => (healthy ? up() : gone()));
    bindOnlineManager(reachability);

    reachability.requestFailed();
    await settle();
    expect(onlineManager.isOnline()).toBe(false);

    healthy = true;
    reachability.checkNow();
    await settle();
    expect(onlineManager.isOnline()).toBe(true);
  });
});
