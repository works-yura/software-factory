import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * A stand-in for a GitLab instance, enough for the Factory's direct GitLab
 * integration (`GITLAB_ACCESS_TOKEN` + `GITLAB_BASE_URL`) to list one project,
 * register it, link it to a Factory, and clone it into a session sandbox.
 *
 * A Claude Code chat needs a repository checkout, and checkouts come only from
 * a source-control integration (GitHub or GitLab); there is no "local repo"
 * provider. So the e2e stack points the real GitLab integration at this server.
 *
 * The REST API answers the handful of endpoints the integration calls with
 * fixed data; git is served for real (smart HTTP through `git http-backend`)
 * from a scratch bare repository, so the session checkout runs the same git
 * commands as against gitlab.com. It speaks HTTPS with a throwaway self-signed
 * certificate (`caFile`), since the checkout refuses non-HTTPS clone URLs.
 */
export interface FakeGitLab {
  url: string;
  token: string;
  /** The self-signed certificate the server presents; trust it in whatever talks to `url`. */
  caFile: string;
  project: { id: number; path: string; defaultBranch: string };
  /** The bare repository the project's git URL serves. */
  bareRepo: string;
  /** Requests nothing here answers, for diagnosing a failed run. */
  unhandled: string[];
  close(): Promise<void>;
}

const TOKEN = 'glpat-e2e-fake-token';

function git(args: string[], cwd: string) {
  return execFileSync('git', ['-c', 'user.name=Factory E2E', '-c', 'user.email=e2e@factory.invalid', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).toString();
}

/** A bare repository `<root>/<path>.git` with one commit on `main`. */
export function createBareRepo(root: string, path: string): string {
  const bare = join(root, `${path}.git`);
  const work = join(root, 'seed-checkout');
  mkdirSync(bare, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(['init', '--bare', '--initial-branch=main', bare], root);
  git(['init', '--initial-branch=main', work], root);
  writeFileSync(join(work, 'README.md'), '# E2E fixture repository\n\nCloned by the Factory end-to-end tests.\n');
  git(['add', 'README.md'], work);
  git(['commit', '-m', 'Initial commit'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', 'origin', 'main'], work);
  return bare;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Smart HTTP through `git http-backend` (CGI): what a real Git host speaks. */
function serveGit(req: IncomingMessage, res: ServerResponse, projectRoot: string, pathInfo: string, query: string) {
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      REMOTE_ADDR: '127.0.0.1',
      REMOTE_USER: 'oauth2',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    headersSent = true;
    res.write(head.subarray(end + 4));
  });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += String(chunk)));
  child.on('close', code => {
    if (!headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`git http-backend failed (${code}): ${stderr}`);
      return;
    }
    res.end();
  });
}

/** A self-signed certificate for 127.0.0.1 / localhost, valid for two days. */
function selfSignedCertificate(dir: string): { key: string; cert: string; certFile: string } {
  const keyFile = join(dir, 'fake-gitlab.key');
  const certFile = join(dir, 'fake-gitlab.crt');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', keyFile, '-out', certFile,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8'), certFile };
}

export async function startFakeGitLab({ root, projectPath = 'e2e/fixture' }: { root: string; projectPath?: string }): Promise<FakeGitLab> {
  const bareRepo = createBareRepo(root, projectPath);
  const project = { id: 4242, path: projectPath, defaultBranch: 'main' };
  const unhandled: string[] = [];
  let url = '';
  const projectBody = () => ({
    id: project.id,
    name: projectPath.split('/').at(-1),
    path: projectPath.split('/').at(-1),
    path_with_namespace: projectPath,
    name_with_namespace: projectPath.replace('/', ' / '),
    web_url: `${url}/${projectPath}`,
    http_url_to_repo: `${url}/${projectPath}.git`,
    default_branch: project.defaultBranch,
    visibility: 'private',
  });

  const tls = selfSignedCertificate(root);
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const path = parsed.pathname;
    const gitMatch = /^\/(.+\.git)(\/.*)$/.exec(path);
    if (gitMatch) {
      serveGit(req, res, root, `/${gitMatch[1]}${gitMatch[2]}`, parsed.search.replace(/^\?/, ''));
      return;
    }
    if (path.startsWith('/api/v4/')) {
      const auth = req.headers.authorization ?? req.headers['private-token'];
      if (!auth || !String(auth).includes(TOKEN)) {
        json(res, 401, { message: '401 Unauthorized' });
        return;
      }
    }
    const projectRoute = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/.exec(path);
    const isProject = (id: string) => {
      const decoded = decodeURIComponent(id);
      return decoded === String(project.id) || decoded === projectPath;
    };
    if (req.method === 'GET' && path === '/api/v4/user') return json(res, 200, { id: 1, username: 'e2e', name: 'E2E Bot' });
    if (req.method === 'GET' && path === '/api/v4/projects') {
      return json(res, 200, Number(parsed.searchParams.get('page') ?? '1') > 1 ? [] : [projectBody()]);
    }
    if (projectRoute && isProject(projectRoute[1]!)) {
      const rest = projectRoute[2] ?? '';
      if (req.method === 'GET' && rest === '') return json(res, 200, projectBody());
      // Lists the integration may read while syncing: nothing there.
      if (req.method === 'GET' && /^\/(issues|merge_requests|members\/all|labels|hooks)$/.test(rest)) return json(res, 200, []);
      if (req.method === 'GET' && rest.startsWith('/repository/branches/')) {
        return json(res, 200, { name: decodeURIComponent(rest.split('/').at(-1)!), default: true });
      }
    }
    unhandled.push(`${req.method} ${req.url}`);
    json(res, 404, { message: '404 Not Found (fake GitLab)' });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token: TOKEN,
    caFile: tls.certFile,
    project,
    bareRepo,
    unhandled,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
