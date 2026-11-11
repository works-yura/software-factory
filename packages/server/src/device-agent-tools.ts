/**
 * Device preview's agent tools (`@factory/device`'s `createDeviceAgentTools`) as session tools: a
 * Mastra session gets them in-process, a Claude Code session over the Factory MCP endpoint (both
 * take the session's `extraTools`). The session drives the device it opens with the `agent-device`
 * CLI `device_open` returns; these tools list, open, look at and close devices.
 *
 * A device is opened under the Factory session's id, the id the Device panel uses, so what an
 * agent opens shows in that session's panel. Agent access itself is the person's choice in the
 * Device panel; the device service refuses until it is on.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { isDeviceError } from '@factory/device/contracts';
import { deviceAgentToolDefinitions } from '@factory/device/server';
import type { DeviceAgentTools } from '@factory/device/server';
import type { IntegrationTools } from '@factory/integrations';

export const DEVICE_TOOL_NAMES = ['device_list', 'device_open', 'device_screenshot', 'device_close'] as const;

/** The Factory session a tool call runs in, or `undefined` outside a session. */
export function deviceSessionId(requestContext: RequestContext | undefined): string | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as AgentControllerRequestContext | undefined;
  return controller?.sessionId || undefined;
}

/** A device refusal the agent can act on or report (turn on agent access, open a device first, …). */
async function refusalOr<T>(call: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await call();
  } catch (error) {
    if (isDeviceError(error)) return { error: error.message };
    throw error;
  }
}

const screenshotOutput = z.union([
  z.object({
    device: z.object({ id: z.string(), name: z.string(), platform: z.string() }).passthrough(),
    screenshot: z.object({
      path: z.string(),
      mimeType: z.literal('image/png'),
      width: z.number().int(),
      height: z.number().int(),
    }),
  }),
  z.object({ error: z.string() }),
]);

export interface FactoryDeviceAgentToolsOptions {
  tools: DeviceAgentTools;
  /** Where screenshots are written; each session gets its own folder. */
  screenshotDir: string;
  requestContext: RequestContext | undefined;
  now?: () => Date;
}

/** The device tools for one session; none outside a session. */
export function createFactoryDeviceAgentTools({
  tools,
  screenshotDir,
  requestContext,
  now = () => new Date(),
}: FactoryDeviceAgentToolsOptions): IntegrationTools {
  const sessionId = deviceSessionId(requestContext);
  if (!sessionId) return {};
  const context = { threadId: sessionId };
  const defs = deviceAgentToolDefinitions;

  return {
    device_list: createTool({
      id: 'device_list',
      description: defs.device_list.description,
      inputSchema: defs.device_list.input,
      execute: async input => refusalOr(() => tools.device_list(context, input)),
    }),
    device_open: createTool({
      id: 'device_open',
      description: defs.device_open.description,
      inputSchema: defs.device_open.input,
      execute: async input => refusalOr(() => tools.device_open(context, input)),
    }),
    device_screenshot: createTool({
      id: 'device_screenshot',
      description:
        `${defs.device_screenshot.description} The PNG is saved on the device host and its path returned; ` +
        'open that path to look at it if the image is not already in front of you.',
      inputSchema: defs.device_screenshot.input,
      outputSchema: screenshotOutput,
      execute: async input =>
        refusalOr(async () => {
          const shot = await tools.device_screenshot(context, input);
          // Base64 in the result would fill the conversation; the file holds the pixels.
          const dir = join(screenshotDir, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
          await mkdir(dir, { recursive: true });
          const path = join(dir, `${now().toISOString().replace(/[:.]/g, '-')}.png`);
          await writeFile(path, Buffer.from(shot.screenshot.data, 'base64'));
          return {
            device: shot.device,
            screenshot: {
              path,
              mimeType: shot.screenshot.mimeType,
              width: shot.screenshot.width,
              height: shot.screenshot.height,
            },
          };
        }),
      // A Mastra model sees the screen itself; MCP clients get the path.
      toModelOutput: output => {
        if ('error' in output) return { type: 'json', value: output };
        return {
          type: 'content',
          value: [
            { type: 'text', text: JSON.stringify(output) },
            {
              type: 'image-data',
              data: readFileSync(output.screenshot.path).toString('base64'),
              mediaType: 'image/png',
            },
          ],
        };
      },
    }),
    device_close: createTool({
      id: 'device_close',
      description: defs.device_close.description,
      inputSchema: defs.device_close.input,
      execute: async input => refusalOr(() => tools.device_close(context, input)),
    }),
  };
}
