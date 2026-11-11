import { createHash } from 'node:crypto';
import * as NodeHttp from 'node:http';
import * as NodeNet from 'node:net';

import { afterEach, expect, it } from 'vitest';

import { LOCAL_DEVICE_HOST_ID } from '../contracts.ts';
import { attachDeviceHubUpgrade } from './DeviceHubProxy.ts';
import type { DeviceService } from './DeviceService.ts';
import { repeatStillFrame } from './mjpegStillFrame.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const withResolvers = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const listen = async <S extends NodeNet.Server>(server: S) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        (server as unknown as NodeHttp.Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return (server.address() as NodeNet.AddressInfo).port;
};

/** A hub WebSocket server: handshakes, sends 0x83, then echoes every frame back unmasked. */
const echoHub = () => {
  const handshakes: Array<{ path: string; headers: Record<string, string> }> = [];
  const sockets: NodeNet.Socket[] = [];
  const server = NodeNet.createServer((socket) => {
    sockets.push(socket);
    let buffered = Buffer.alloc(0);
    let open = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!open) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [requestLine, ...lines] = buffered.subarray(0, end).toString('latin1').split('\r\n');
        const headers = Object.fromEntries(
          lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]),
        );
        handshakes.push({ path: requestLine!.split(' ')[1]!, headers });
        const accept = createHash('sha1')
          .update(`${headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(Buffer.from([0x82, 0x01, 0x83]));
        buffered = buffered.subarray(end + 4);
        open = true;
      }
      // Client frames are small and masked: FIN|opcode, MASK|length, 4-byte key, payload.
      while (buffered.length >= 2) {
        const length = buffered[1]! & 0x7f;
        if (buffered.length < 6 + length) return;
        const key = buffered.subarray(2, 6);
        const payload = Buffer.from(buffered.subarray(6, 6 + length).map((byte, index) => byte ^ key[index % 4]!));
        const opcode = buffered[0]! & 0x0f;
        buffered = buffered.subarray(6 + length);
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
      }
    });
  });
  return { server, handshakes, sockets };
};

const proxyServer = async (hubPort: number, authorize?: () => boolean) => {
  const service = {
    currentReadiness: async (hostId?: string) =>
      hostId === LOCAL_DEVICE_HOST_ID ? { hostId, hub: { origin: `http://127.0.0.1:${hubPort}` } } : null,
  } as unknown as DeviceService;
  const server = NodeHttp.createServer((_, response) => response.writeHead(404).end());
  attachDeviceHubUpgrade(server, { service, basePath: '/api/device', ...(authorize ? { authorize } : {}) });
  return listen(server);
};

/** Sends a raw upgrade request and resolves the response head. */
const rawUpgrade = (port: number, path: string) =>
  new Promise<{ head: string; socket: NodeNet.Socket }>((resolve, reject) => {
    const socket = NodeNet.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      );
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end >= 0) resolve({ head: received.slice(0, end), socket });
    });
    socket.on('error', reject);
    cleanups.push(() => void socket.destroy());
  });

it('preserves binary input and admission frames through the real socket proxy', async () => {
  const hub = echoHub();
  const hubPort = await listen(hub.server);
  const port = await proxyServer(hubPort);
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/api/device/hub/local/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
  );
  cleanups.push(() => client.close());
  client.binaryType = 'arraybuffer';
  const frames: number[][] = [];
  const received = withResolvers<void>();
  client.addEventListener('error', () => received.reject(new Error('Proxy failed')));
  client.addEventListener('message', ({ data }) => {
    frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
    if (frames.length === 1) {
      client.send(Uint8Array.of(0x03, 1));
      client.send(Uint8Array.of(0x03, 2));
    } else if (frames.length === 3) received.resolve();
  });
  await received.promise;
  expect(frames).toEqual([[0x83], [0x03, 1], [0x03, 2]]);
  expect(hub.handshakes[0]?.path).toBe('/vendor/serve-sim/helper/ws?device=test');
  expect(hub.handshakes[0]?.headers.host).toBe(`127.0.0.1:${hubPort}`);
});

it('rewrites the origin and drops credentials on the forwarded handshake', async () => {
  const hub = echoHub();
  const hubPort = await listen(hub.server);
  const port = await proxyServer(hubPort);
  const socket = NodeNet.connect(port, '127.0.0.1');
  cleanups.push(() => void socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const head = new Promise<string>((resolve) => socket.once('data', (chunk) => resolve(chunk.toString('latin1'))));
  socket.write(
    `GET /api/device/hub/local/vendor/serve-emu/ws?device=emulator-5554 HTTP/1.1\r\nHost: relay.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://relay.test\r\nCookie: session=private\r\nAuthorization: Bearer private\r\nX-Forwarded-Proto: https\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  expect(await head).toMatch(/^HTTP\/1\.1 101 /);
  expect(hub.handshakes[0]?.headers).toMatchObject({ origin: `http://127.0.0.1:${hubPort}`, upgrade: 'websocket' });
  expect(hub.handshakes[0]?.headers).not.toHaveProperty('cookie');
  expect(hub.handshakes[0]?.headers).not.toHaveProperty('authorization');
  expect(hub.handshakes[0]?.headers).not.toHaveProperty('x-forwarded-proto');
});

it.each([
  ['/api/device/hub/local/vendor/serve-sim/exec', '404'],
  ['/api/device/hub/local/api/devices', '404'],
  ['/api/device/hub/other/vendor/serve-sim/helper/ws', '503'],
])('refuses the upgrade of %s before reaching the hub', async (path, status) => {
  const hub = echoHub();
  const hubPort = await listen(hub.server);
  const port = await proxyServer(hubPort);
  const { head } = await rawUpgrade(port, path);
  expect(head.split('\r\n')[0]).toContain(` ${status} `);
  expect(hub.handshakes).toEqual([]);
});

it('refuses upgrades the embedding server does not authorize', async () => {
  const hub = echoHub();
  const hubPort = await listen(hub.server);
  const port = await proxyServer(hubPort, () => false);
  const { head } = await rawUpgrade(port, '/api/device/hub/local/vendor/serve-sim/helper/ws');
  expect(head.split('\r\n')[0]).toContain(' 403 ');
  expect(hub.handshakes).toEqual([]);
});

it('closes an upstream socket that is still handshaking when the client goes away', async () => {
  const dialed = withResolvers<NodeNet.Socket>();
  // Accepts the connection and never answers the WebSocket handshake.
  const hubPort = await listen(
    NodeNet.createServer((socket) => {
      socket.on('error', () => undefined);
      dialed.resolve(socket);
    }),
  );
  const port = await proxyServer(hubPort);
  const client = NodeNet.connect(port, '127.0.0.1');
  client.on('error', () => undefined);
  await new Promise<void>((resolve) => client.once('connect', resolve));
  client.write(
    'GET /api/device/hub/local/vendor/serve-sim/helper/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  const connection = await dialed.promise;
  const abandoned = new Promise<void>((resolve) => connection.once('close', () => resolve()));
  client.destroy();
  await abandoned;
});

it('re-sends the last MJPEG part once the stream goes quiet', async () => {
  const part = (body: string) =>
    new TextEncoder().encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n`);
  let push!: (chunk: Uint8Array) => void;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
    },
  });
  const reader = repeatStillFrame(source).getReader();
  const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
  push(part('one'));
  expect(decode((await reader.read()).value)).toContain('one');
  // Nothing new arrives: the last part repeats after the quiet period.
  expect(decode((await reader.read()).value)).toContain('one');
  // A new frame passes through as is.
  push(part('two'));
  expect(decode((await reader.read()).value)).toContain('two');
  await reader.cancel();
});
