// expo-device-hub started with `--require-token` makes a random session token and prints it once, in
// the link of its startup message (`Local:   http://localhost:<port>/?token=<token>`). Every request
// and WebSocket then needs `Authorization: Bearer <token>`; without the flag the hub on loopback
// answers anyone on this machine, an agent running as another user among them.

const TOKEN_IN_LINK = /[?&]token=([A-Za-z0-9._~-]+)/;

/** The session token in a line of the hub's output, if the line carries it. */
export const hubSessionTokenOf = (line: string): string | undefined => TOKEN_IN_LINK.exec(line)?.[1];

/** The line with its session token hidden, for logs. */
export const withoutHubSessionToken = (line: string): string =>
  line.replace(TOKEN_IN_LINK, (match, token: string) => match.replace(token, '<token>'));

/** Headers that authorize a request to the hub. */
export const hubAuthorization = (token: string): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${token}`,
});
