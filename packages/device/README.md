# @factory/device

Device preview: iOS Simulator / Android emulator streamed into the web UI, touch and
keyboard input, device settings and app actions, agent control and video recording.
Ported from t3code (MIT, see `LICENSE`; source commit in `vendor/t3code/COMMIT`) with
`effect` removed. `vendor/t3code/` holds the untouched originals for reference; it is not compiled.

## How it works

The package does not capture video itself. On first use the server npm-installs two tools
into the state dir and drives them:

| Tool | Role |
|---|---|
| [`expo-device-hub`](https://github.com/expo/expo-device-hub) | HTTP hub on `127.0.0.1` (fork of [`serve-sim`](https://github.com/EvanBacon/serve-sim) + `serve-emu`): `stream.mjpeg`, `stream.avcc` (H.264), WebRTC, input websocket, screenshot, accessibility tree |
| [`agent-device`](https://github.com/callstack/agent-device) | CLI for agents: taps, gestures, apps, `record start --scope device out.mp4` / `record stop` |

Browser picks WebRTC, else H.264 over WebSocket decoded with WebCodecs, else MJPEG.
The server proxies only a whitelist of hub paths: the hub has shell-exec endpoints on loopback.

Requirements on the device host: Xcode (`xcrun simctl`) for iOS, Android SDK for Android, Node.

## Layout

| Entry | What |
|---|---|
| `@factory/device/contracts` | zod schemas, types, tagged errors |
| `@factory/device/server` | `createDeviceService`, `createDeviceRoutes` (Hono), `attachDeviceHubUpgrade` (raw WebSocket proxy), `createDeviceAgentTools` |
| `@factory/device/client` | stream transport, input, screenshot, three.js device frame |
| `@factory/device/react` | `DevicePanel`, `DeviceWorkspace`, `DeviceStreamView`, `createDeviceApi`, `DeviceProvider` |

## Wiring (not done yet)

```ts
// server
const service = createDeviceService({ stateDir });
app.route('/api/device', createDeviceRoutes(service, { basePath: '/api/device' }));
attachDeviceHubUpgrade(httpServer, { service, basePath: '/api/device' });

// ui
<DevicePanel threadId={id} api={createDeviceApi({ basePath: '/api/device' })}
             modelUrls={defaultDeviceModelUrls()} />
```

HTTP API: `GET /state`, `GET /events` (SSE `state`), `POST /list|configure|open|close|shutdown|detail|action`,
`ALL /hub/:hostId/*`. Errors: `{ _tag, message }`.

UI host must let Tailwind scan `packages/device/src/react` (`@source`) and define t3code's theme
tokens used there (`text-success`, `text-warning-foreground`, `bg-info`, `text-2xs`, `dropdown-glass`, ...).

## Not ported

EAS cloud simulators, Simlock leases, SSH remote hosts, the mobile (React Native) app, MCP wiring
(`agentTools.ts` has the logic; mount it in `@factory/mcp`), auth scopes on the proxy (rely on the
host server's middleware). `DeviceHost` stays general so remote hosts can come back;
`DeviceHostSummary.kind` would need widening then.
