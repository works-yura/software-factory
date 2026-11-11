// Loopback-only hubs expose shell execution or unauthenticated actions. Only the paths below
// ever reach a hub; everything else is refused before a request is made. Authentication is the
// embedding server's job: wrap the routes in its middleware and pass `authorize` for upgrades.
import type { IncomingMessage, Server } from 'node:http';
import * as NodeNet from 'node:net';
import type { Duplex } from 'node:stream';

import type { HubUpstream } from './DeviceHost.ts';
import type { DeviceService } from './DeviceService.ts';
import { repeatStillFrame } from './mjpegStillFrame.ts';

export const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

// Paths that take methods besides GET; one missing from ALLOWED_PATHS takes no GET.
export const MUTABLE_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  // WebRTC signalling: opening and closing a view of the stream.
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/api\/fold$/,
];

export const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'cookie',
  'authorization',
  'dpop',
  'content-length',
  'accept-encoding',
  // The client's HTTPS hop makes the hub reject our loopback Origin.
  'x-forwarded-proto',
]);

// A raw upgrade forwards the WebSocket handshake itself, so only credentials and hop headers go.
const DROPPED_UPGRADE_HEADERS = new Set(['host', 'cookie', 'authorization', 'dpop', 'content-length', 'x-forwarded-proto']);

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const matches = (paths: ReadonlyArray<RegExp>, hubPath: string) => paths.some((pattern) => pattern.test(hubPath));

/** The query the hub sees: without the server's own parameters. */
const upstreamSearchOf = (search: string) => {
  const upstreamSearch = new URLSearchParams(search);
  // Consume the auth ticket here; never forward it to the hub.
  upstreamSearch.delete('wsTicket');
  upstreamSearch.delete('hostId');
  return upstreamSearch;
};

const forwardHeaders = (headers: Headers, origin: string) => {
  const forwarded: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (DROPPED_REQUEST_HEADERS.has(name)) return;
    forwarded[name] = value;
  });
  // serve-emu refuses mutations whose Origin differs from the request origin.
  if (headers.get('origin') !== null) forwarded.origin = origin;
  return forwarded;
};

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const proxyHttp = async (
  request: Request,
  upstreamUrl: string,
  extraHeaders: Readonly<Record<string, string>>,
  http: typeof fetch,
): Promise<Response> => {
  const method = request.method.toUpperCase();
  if (!HTTP_METHODS.has(method)) return text('Method Not Allowed', 405);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let response: Response;
  try {
    response = await http(upstreamUrl, {
      method,
      headers: { ...forwardHeaders(request.headers, new URL(upstreamUrl).origin), ...extraHeaders },
      // A bare stream body would be octet-stream; the client's content-type is forwarded above,
      // since serve-sim refuses WebRTC offers that are not application/json.
      ...(hasBody && request.body ? { body: request.body, duplex: 'half' } : {}),
      signal: request.signal,
      redirect: 'manual',
    } as RequestInit);
  } catch {
    return text('Bad Gateway', 502);
  }
  const headers = new Headers();
  const encoded = response.headers.has('content-encoding');
  response.headers.forEach((value, name) => {
    // A cookie from an upstream would land on this server's origin.
    if (name === 'content-encoding' || name === 'transfer-encoding' || name === 'connection' || name === 'set-cookie')
      return;
    // fetch decodes compressed bodies, so their length no longer applies.
    if (encoded && name === 'content-length') return;
    headers.set(name, value);
  });
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers.set('cache-control', 'no-store, no-transform');
  const body =
    NULL_BODY_STATUSES.has(response.status) || !response.body
      ? null
      : headers.get('content-type')?.startsWith('multipart/x-mixed-replace')
        ? repeatStillFrame(response.body)
        : response.body;
  return new Response(body, { status: response.status, headers });
};

export interface DeviceHubProxyRequest {
  readonly hostId: string;
  /** The hub path after `{hubBasePath}/{hostId}`, starting with `/`. */
  readonly hubPath: string;
  readonly request: Request;
  /** Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Forwards one whitelisted HTTP request to a host's hub. Device errors from the screenshot
 * shortcut propagate; callers map them to responses.
 */
export const proxyDeviceHubRequest = async (service: DeviceService, input: DeviceHubProxyRequest): Promise<Response> => {
  const { request, hubPath } = input;
  const http = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const url = new URL(request.url);
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  const allowed = upgrade
    ? matches(ALLOWED_WS_PATHS, hubPath)
    : matches(ALLOWED_PATHS, hubPath) || matches(MUTABLE_PATHS, hubPath);
  if (!allowed) return text('Not Found', 404);
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  if (!upgrade && !matches(readOnly ? ALLOWED_PATHS : MUTABLE_PATHS, hubPath)) {
    return text('Method Not Allowed', 405);
  }
  // WebSockets need the raw socket; `attachDeviceHubUpgrade` serves them on the HTTP server.
  if (upgrade) return text('Upgrade Required', 426);
  const ready = await service.currentReadiness(input.hostId);
  if (!ready) return text('Device hub is not running', 503);
  const upstreamSearch = upstreamSearchOf(url.search);
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : '';
  const screenshotDevice = upstreamSearch.get('device');
  if (!ready.upstream && hubPath === '/vendor/serve-sim/api/screenshot' && screenshotDevice) {
    const { png } = await service.screenshot({ hostId: ready.hostId, deviceId: screenshotDevice });
    return new Response(png as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store, no-transform' },
    });
  }
  // Hosts with several upstreams (one per cloud session) route and authenticate requests themselves.
  const routed: HubUpstream | null | undefined = ready.upstream
    ? await ready.upstream(hubPath, upstreamSearch)
    : undefined;
  if (routed === null) return text('Not Found', 404);
  const upstreamUrl = routed?.url ?? `${ready.hub.origin}${hubPath}${search}`;
  return proxyHttp(request, upstreamUrl, routed?.headers ?? {}, http);
};

/** Splits `{hubBasePath}/{hostId}/{hubPath}`; null when the path is not under the mount. */
export const parseHubPath = (pathname: string, hubBasePath: string) => {
  const prefix = `${hubBasePath.replace(/\/+$/, '')}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const rawHostId = slash < 0 ? rest : rest.slice(0, slash);
  let hostId: string;
  try {
    hostId = decodeURIComponent(rawHostId);
  } catch {
    return null;
  }
  if (!hostId) return null;
  return { hostId, hubPath: slash < 0 ? '/' : rest.slice(slash) };
};

export interface DeviceHubUpgradeOptions {
  readonly service: DeviceService;
  /** The base path `createDeviceRoutes` is mounted at; hub sockets live under `{basePath}/hub`. */
  readonly basePath: string;
  /**
   * Decides whether a socket may connect, before anything reaches the hub. Defaults to allowing
   * every request; the routes themselves rely on the embedding server's middleware.
   */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

const rejectUpgrade = (socket: Duplex, status: number, reason: string) => {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
};

/**
 * Serves WebSocket upgrades for `{basePath}/hub/{hostId}/...` by piping the raw socket to the
 * host's hub. Only `ALLOWED_WS_PATHS` connect. Upgrades for other paths are left to the server's
 * other `upgrade` listeners. Returns a function that detaches the listener.
 */
export const attachDeviceHubUpgrade = (server: Server, options: DeviceHubUpgradeOptions): (() => void) => {
  const hubBasePath = `${options.basePath.replace(/\/+$/, '')}/hub`;
  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://device.invalid');
    } catch {
      return;
    }
    const parsed = parseHubPath(url.pathname, hubBasePath);
    if (!parsed) return;
    socket.on('error', () => socket.destroy());
    void handleUpgrade(options, request, socket, head, url, parsed).catch(() => rejectUpgrade(socket, 502, 'Bad Gateway'));
  };
  server.on('upgrade', listener);
  return () => void server.off('upgrade', listener);
};

const handleUpgrade = async (
  options: DeviceHubUpgradeOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  { hostId, hubPath }: { hostId: string; hubPath: string },
) => {
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !matches(ALLOWED_WS_PATHS, hubPath)) {
    return rejectUpgrade(socket, 404, 'Not Found');
  }
  if (options.authorize && !(await options.authorize(request))) return rejectUpgrade(socket, 403, 'Forbidden');
  const ready = await options.service.currentReadiness(hostId);
  if (!ready) return rejectUpgrade(socket, 503, 'Service Unavailable');
  const upstreamSearch = upstreamSearchOf(url.search);
  const routed = ready.upstream ? await ready.upstream(hubPath, upstreamSearch) : undefined;
  if (routed === null) return rejectUpgrade(socket, 404, 'Not Found');
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : '';
  const target = new URL(routed?.url ?? `${ready.hub.origin}${hubPath}${search}`);
  // A raw pipe speaks plain HTTP/1.1 only; TLS upstreams need a WebSocket client.
  if (target.protocol !== 'http:' && target.protocol !== 'ws:') return rejectUpgrade(socket, 502, 'Bad Gateway');
  if (socket.destroyed) return;

  const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!;
    const lower = name.toLowerCase();
    if (DROPPED_UPGRADE_HEADERS.has(lower)) continue;
    // serve-emu refuses connections whose Origin differs from the request origin.
    if (lower === 'origin') {
      lines.push(`Origin: http://${target.host}`);
      continue;
    }
    if (lower === 'sec-websocket-protocol' && routed && routed.protocols.length > 0) continue;
    lines.push(`${name}: ${raw[index + 1]}`);
  }
  if (routed) {
    if (routed.protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${routed.protocols.join(', ')}`);
    for (const [name, value] of Object.entries(routed.headers)) lines.push(`${name}: ${value}`);
  }

  const upstream = NodeNet.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80) });
  const teardown = () => {
    // A hub that has not answered the handshake may not be reading; a reset still reaches it.
    if (!upstream.destroyed) {
      if (upstream.bytesRead === 0 && !upstream.connecting) upstream.resetAndDestroy();
      else upstream.destroy();
    }
    socket.destroy();
  };
  upstream.setTimeout(10_000, () => {
    if (upstream.connecting) teardown();
  });
  upstream.once('error', () => {
    if (upstream.bytesRead > 0) return teardown();
    // Nothing reached the client yet, so it can still get an HTTP answer.
    upstream.destroy();
    rejectUpgrade(socket, 502, 'Bad Gateway');
  });
  socket.once('error', teardown);
  socket.once('close', teardown);
  // The server keeps upgraded sockets half-open; a client gone before the hub answered ends both.
  socket.once('end', () => {
    if (upstream.connecting || upstream.bytesRead === 0) teardown();
  });
  upstream.once('close', () => {
    if (!socket.writableEnded) socket.destroy();
  });
  upstream.once('connect', () => {
    if (socket.destroyed || socket.readableEnded) return teardown();
    upstream.setTimeout(0);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
};
