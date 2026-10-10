// A tiny in-memory npm registry for E2E tests.
// It listens on 127.0.0.1 only and implements just enough of the registry API
// for `npm publish` / `pnpm publish` of the placeholder package.
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

/**
 * @param {object} [options]
 * @param {string} [options.token] - Bearer token that publish requests must carry. When omitted, any request is accepted.
 * @param {Record<string, string[]>} [options.published] - Versions that already exist, keyed by package name.
 */
export async function startFakeRegistry({ token, published = {} } = {}) {
  const requests = [];
  const publishes = [];
  const packages = new Map(Object.entries(published).map(([name, versions]) => [name, new Set(versions)]));

  let baseUrl;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const record = { method: req.method, url: req.url, headers: req.headers, rawBody };
    requests.push(record);

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authorized = token === undefined || req.headers.authorization === `Bearer ${token}`;

    const pathname = new URL(req.url, 'http://localhost').pathname;
    // Web login (`npm login` / `pnpm login`): hand out `token` immediately, no browser involved.
    if (req.method === 'POST' && pathname === '/-/v1/login') {
      return send(200, { loginUrl: `${baseUrl}-/fake-login`, doneUrl: `${baseUrl}-/v1/done` });
    }
    if (req.method === 'GET' && pathname === '/-/v1/done') {
      return token === undefined ? send(404, { error: 'Not found' }) : send(200, { token });
    }
    if (pathname === '/-/whoami') {
      return authorized && token !== undefined ? send(200, { username: 'fake-user' }) : send(401, { error: 'Unauthorized' });
    }
    // Scoped names arrive as `/@scope%2fname`.
    const name = decodeURIComponent(pathname.slice(1));

    if (req.method === 'PUT') {
      if (!authorized) {
        return send(401, { error: 'Unable to authenticate, need: Bearer authorization' });
      }
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return send(400, { error: 'Invalid JSON' });
      }
      const versions = Object.keys(body.versions ?? {});
      const existing = packages.get(name) ?? new Set();
      const conflict = versions.find((version) => existing.has(version));
      if (conflict) {
        return send(403, { error: `You cannot publish over the previously published versions: ${conflict}.` });
      }
      const attachments = Object.entries(body._attachments ?? {}).map(([filename, attachment]) => ({
        filename,
        files: readTarball(Buffer.from(attachment.data, 'base64'))
      }));
      publishes.push({ name, body, headers: req.headers, attachments });
      for (const version of versions) existing.add(version);
      packages.set(name, existing);
      return send(200, { ok: true, success: true });
    }

    if (req.method === 'GET' && packages.has(name)) {
      const versions = Object.fromEntries([...packages.get(name)].map((version) => [version, { name, version }]));
      return send(200, { name, versions, 'dist-tags': {} });
    }
    return send(404, { error: 'Not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  return {
    url: baseUrl,
    requests,
    publishes,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// Extract regular files from a .tgz into a { path: content } map.
export function readTarball(tgz) {
  const tar = gunzipSync(tgz);
  const files = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const dataStart = offset + 512;
    if (type === '0' || type === '') {
      files[path] = tar.subarray(dataStart, dataStart + size).toString('utf8');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}
