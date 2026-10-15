/**
 * Local HTTP fixture server for e2e tests. We bind to 127.0.0.1 only
 * and rely on assertSafeUrl rejecting 127.0.0.0/8 by default — so the
 * e2e tests must use the `--allow-private` override on the SSRF gate.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export const FIXTURE_PAGES: Record<string, { status: number; contentType: string; body: string; headers?: Record<string, string> }> = {
  '/': {
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head>
      <title>Fixture Site</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="description" content="A fixture site used by WBH tests; reasonably long description.">
      <link rel="icon" href="/favicon.ico">
    </head><body>
      <h1>Home</h1>
      <a href="/ok">OK page</a>
      <a href="/broken">Broken page</a>
      <a href="/redirect">Redirects to /ok</a>
      <a href="/loop">Redirect loop</a>
      <a href="/missing-image">Image that is broken</a>
      <img src="/missing-image" alt="missing">
      <a href="https://example.com/">External</a>
    </body></html>`,
  },
  '/ok': {
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>OK</title></head><body>OK</body></html>',
  },
  '/broken': {
    status: 404,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Not Found</title></head><body>404</body></html>',
  },
  '/redirect': {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: '/ok' } as Record<string, string>,
  },
  '/loop-a': {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: '/loop-b' } as Record<string, string>,
  },
  '/loop-b': {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: '/loop-a' } as Record<string, string>,
  },
  '/loop': {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: '/loop-a' } as Record<string, string>,
  },
  '/missing-image': {
    status: 404,
    contentType: 'text/plain',
    body: 'not found',
  },
  '/favicon.ico': {
    status: 200,
    contentType: 'image/x-icon',
    body: '',
  },
};

export function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const spec = FIXTURE_PAGES[url.pathname];
      if (!spec) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': spec.contentType };
      if (spec.headers) Object.assign(headers, spec.headers);
      res.writeHead(spec.status, headers);
      res.end(spec.body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('could not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}