// A stdio MCP server for the contract tests: one tool, `echo`, that answers
// `ECHO:<text>` and appends the text to the file named by ECHO_LOG, so a test
// can tell a call that ran from one that was refused.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.ECHO_LOG;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const tool = {
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [tool] } });
  } else if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    if (log) appendFileSync(log, text + '\n');
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ECHO:' + text }] } });
  } else {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
