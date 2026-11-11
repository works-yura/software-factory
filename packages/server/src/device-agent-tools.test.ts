import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestContext } from '@mastra/core/request-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceToolUnavailableError } from '@factory/device/contracts';
import type { DeviceAgentTools } from '@factory/device/server';

import { createFactoryDeviceAgentTools, DEVICE_TOOL_NAMES } from './device-agent-tools.ts';

type AnyTool = { execute: (input: unknown, context?: unknown) => Promise<unknown>; toModelOutput?: (output: unknown) => unknown };

const device = { id: 'SIM-1', name: 'iPhone 16', platform: 'ios', version: '18.0', hostId: 'local', booted: true };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3]);

function sessionContext(sessionId = 'session-1'): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set('user', { id: 'user-1', organizationId: 'org-1' });
  requestContext.set('controller', { sessionId, threadId: 'thread-1', resourceId: 'resource-1' });
  return requestContext;
}

function fakeTools(): DeviceAgentTools {
  return {
    device_list: vi.fn(async () => ({ hostStatuses: {}, hosts: [], devices: [], open: [] })),
    device_open: vi.fn(async () => {
      throw new DeviceToolUnavailableError({ reason: 'Agent device access is turned off for this environment.' });
    }),
    device_screenshot: vi.fn(async () => ({
      device,
      screenshot: { mimeType: 'image/png' as const, data: PNG.toString('base64'), width: 2, height: 3 },
    })),
    device_close: vi.fn(async () => ({})),
  } as unknown as DeviceAgentTools;
}

describe('device tools for agent sessions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-device-tools-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('offers no device tools outside a session', () => {
    expect(createFactoryDeviceAgentTools({ tools: fakeTools(), screenshotDir: dir, requestContext: undefined })).toEqual({});
    expect(
      createFactoryDeviceAgentTools({ tools: fakeTools(), screenshotDir: dir, requestContext: new RequestContext() }),
    ).toEqual({});
  });

  it("opens devices under the Factory session's id, the one its Device panel shows", async () => {
    const tools = fakeTools();
    const offered = createFactoryDeviceAgentTools({ tools, screenshotDir: dir, requestContext: sessionContext() });
    expect(Object.keys(offered).sort()).toEqual([...DEVICE_TOOL_NAMES].sort());

    await (offered.device_list as AnyTool).execute({});
    expect(tools.device_list).toHaveBeenCalledWith({ threadId: 'session-1' }, {});
  });

  it('hands a device refusal back to the agent instead of failing the call', async () => {
    const offered = createFactoryDeviceAgentTools({ tools: fakeTools(), screenshotDir: dir, requestContext: sessionContext() });
    await expect((offered.device_open as AnyTool).execute({})).resolves.toEqual({
      error: 'Agent device access is turned off for this environment.',
    });
  });

  it('saves the screenshot to a file and shows the Mastra model the image', async () => {
    const offered = createFactoryDeviceAgentTools({
      tools: fakeTools(),
      screenshotDir: dir,
      requestContext: sessionContext('session/../x'),
      now: () => new Date('2026-11-11T08:00:00.000Z'),
    });
    const tool = offered.device_screenshot as AnyTool;
    const output = (await tool.execute({})) as { screenshot: { path: string; width: number; height: number } };

    expect(output.screenshot).toMatchObject({ mimeType: 'image/png', width: 2, height: 3 });
    expect(output.screenshot.path).toBe(join(dir, 'session____x', '2026-11-11T08-00-00-000Z.png'));
    expect(await readFile(output.screenshot.path)).toEqual(PNG);
    // No base64 in the result itself: it would fill the conversation.
    expect(JSON.stringify(output)).not.toContain(PNG.toString('base64'));

    const model = tool.toModelOutput!(output) as { type: string; value: Array<{ type: string; data?: string }> };
    expect(model.type).toBe('content');
    expect(model.value.find(part => part.type === 'image-data')?.data).toBe(PNG.toString('base64'));
  });
});
