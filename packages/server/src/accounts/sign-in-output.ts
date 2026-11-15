/**
 * Reading what a harness CLI's sign-in prints: the page to open (and a device code) in text that may
 * carry terminal escapes — colours, and OSC 8 hyperlinks whose target repeats the URL the text shows.
 */

/** OSC sequences (an OSC 8 hyperlink's target among them), ended by BEL or ST. */
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** CSI sequences (colours, cursor moves) and the lone two-character escapes. */
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** `text` without terminal escapes: what a person would read in a terminal. */
export function stripTerminalEscapes(text: string): string {
  return text.replace(OSC, '').replace(CSI, '');
}

/**
 * The first well-formed `https` URL in `text` on one of `hosts` (or a subdomain), escapes stripped;
 * `undefined` until the CLI printed one — and printed past it: output arrives in pieces, and a URL
 * at the very end may go on in the next. A URL the text shows twice in a row (`…state=xhttps://…`)
 * is cut at its repeat, and a query parameter given again keeps its first value.
 */
export function findSignInUrl(text: string, hosts: readonly string[]): string | undefined {
  const plain = stripTerminalEscapes(text);
  // eslint-disable-next-line no-control-regex
  for (const match of plain.matchAll(/https:\/\/[^\s"'<>`\x00-\x1f\x7f]+/g)) {
    // Not yet known to be whole.
    if (match.index + match[0].length >= plain.length) return undefined;
    let candidate = match[0];
    const repeat = candidate.indexOf('https://', 'https://'.length);
    if (repeat > 0) candidate = candidate.slice(0, repeat);
    candidate = candidate.replace(/[.,;:)\]]+$/, '');
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    if (!hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) continue;
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) if (!params.has(key)) params.append(key, value);
    // Untouched unless a parameter repeats: the provider reads exactly what the CLI printed.
    if ([...params.keys()].length !== [...url.searchParams.keys()].length) url.search = params.toString();
    return url.toString();
  }
  return undefined;
}

/** A device code (`ABCD-EFGH1`) printed after the words "one-time code", escapes stripped; only once printed past it. */
export function findDeviceCode(text: string): string | undefined {
  const plain = stripTerminalEscapes(text);
  const after = /one-time code/i.exec(plain);
  if (!after) return undefined;
  return /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,8})(?=[^A-Za-z0-9-])/.exec(plain.slice(after.index))?.[1];
}
