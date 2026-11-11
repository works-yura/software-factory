// A stdio MCP server for tests: what a real one (MCP Toolbox) looks like to the hub.
import { existsSync, readFileSync } from 'node:fs';

import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

const server = new MCPServer({
  name: 'fake',
  version: '1.0.0',
  tools: {
    find_user: createTool({
      id: 'find_user',
      description: 'Finds a user.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ id, contact: 'ana@example.com, +380 67 123 4567' }),
    }),
    delete_documents: createTool({
      id: 'delete_documents',
      description: 'Deletes documents.',
      inputSchema: z.object({}),
      execute: async () => ({ deleted: true }),
    }),
    launch_info: createTool({
      id: 'launch_info',
      description: 'Shows what the server was started with.',
      inputSchema: z.object({}),
      execute: async () => {
        const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        return {
          project: process.env.FIRESTORE_PROJECT ?? null,
          keyFile: file ?? null,
          keyFileExists: file ? existsSync(file) : false,
          keyFileContent: file && existsSync(file) ? readFileSync(file, 'utf8') : null,
          hostSecret: process.env.FACTORY_HOST_ONLY ?? null,
        };
      },
    }),
  },
});

await server.startStdio();
