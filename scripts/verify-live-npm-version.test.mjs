import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const script = fileURLToPath(new URL('./verify-live-npm-version.sh', import.meta.url));
const publishYml = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8');

function packument(pkg, version, registryUrl) {
  const tarball = `${registryUrl}/${pkg}/-/${pkg}-${version}.tgz`;
  return {
    name: pkg,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: pkg,
        version,
        dist: { tarball },
      },
    },
  };
}

function startRegistry(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

function closeRegistry(server) {
  return new Promise((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
}

function runVerify(pkg, version, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, pkg, version], {
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function servePackument({ url, doc, tarballStatus = 200, visibleAfterMs = 0, startedAt = Date.now() }) {
  return (req, res) => {
    const visible = Date.now() >= startedAt + visibleAfterMs;
    const tarballPath = doc ? `/${doc.name}/-/${doc.name}-${Object.keys(doc.versions)[0]}.tgz` : '';
    if (req.url === tarballPath && (req.method === 'HEAD' || req.method === 'GET')) {
      if (!visible) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(tarballStatus, { 'content-type': 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : 'tgz');
      return;
    }
    if (req.url === `/${doc?.name}` || req.url === `/${doc?.name}/`) {
      if (!visible) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}

const shortWindow = {
  VERIFY_DEADLINE_SECONDS: '8',
  VERIFY_INITIAL_INTERVAL_SECONDS: '1',
  VERIFY_MAX_INTERVAL_SECONDS: '2',
};

test('gate publish verify uses the shared registry poller, not the 3-minute inline loop', () => {
  assert.match(publishYml, /verify-live-npm-version\.sh twzrd-x402-gate/);
  assert.doesNotMatch(publishYml, /seq 1 18/);
  assert.doesNotMatch(publishYml, /after 3 minutes/);
  assert.match(publishYml, /npm publish --access public --provenance/);
});

test('already-visible version passes npm view, packument tarball, and dist-tags', async () => {
  const { server, url } = await startRegistry((req, res) => {
    servePackument({ url, doc: packument('mock-verify-pkg', '1.2.3', url) })(req, res);
  });
  try {
    const result = await runVerify('mock-verify-pkg', '1.2.3', {
      ...shortWindow,
      VERIFY_NPM_REGISTRY: url,
      NPM_CONFIG_REGISTRY: url,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified live: mock-verify-pkg@1\.2\.3 \(attempt 1\)/);
    assert.match(result.stdout, /dist\.tarball=/);
    assert.match(result.stdout, /tarball HEAD 200/);
  } finally {
    await closeRegistry(server);
  }
});

test('version that appears after a delay is accepted inside the window', async () => {
  const { server, url } = await startRegistry((req, res) => {
    // First packument GET 404s so attempt 1 fails; later GETs succeed.
    if (!server.hideHits) server.hideHits = 0;
    const doc = packument('mock-verify-delay', '9.9.9', url);
    const isPackument = req.url === '/mock-verify-delay' || req.url === '/mock-verify-delay/';
    if (isPackument) {
      server.hideHits += 1;
      if (server.hideHits === 1) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
    }
    servePackument({ url, doc })(req, res);
  });
  try {
    const result = await runVerify('mock-verify-delay', '9.9.9', {
      ...shortWindow,
      VERIFY_NPM_REGISTRY: url,
      NPM_CONFIG_REGISTRY: url,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified live: mock-verify-delay@9\.9\.9 \(attempt [2-9]\)/);
  } finally {
    await closeRegistry(server);
  }
});

test('a version the registry never has fails closed', async () => {
  const { server, url } = await startRegistry((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  try {
    const result = await runVerify('mock-verify-absent', '0.0.0-registry-verify-absent', {
      VERIFY_DEADLINE_SECONDS: '3',
      VERIFY_INITIAL_INTERVAL_SECONDS: '1',
      VERIFY_MAX_INTERVAL_SECONDS: '1',
      VERIFY_ATTEMPTS: '2',
      VERIFY_NPM_REGISTRY: url,
      NPM_CONFIG_REGISTRY: url,
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Registry still does not show mock-verify-absent@0\.0\.0-registry-verify-absent/);
    assert.doesNotMatch(result.stdout, /Verified live/);
  } finally {
    await closeRegistry(server);
  }
});

test('packument without a tarball or dist-tags cannot pass', async () => {
  const { server, url } = await startRegistry((req, res) => {
    if (req.url === '/mock-verify-incomplete' || req.url === '/mock-verify-incomplete/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: 'mock-verify-incomplete',
        'dist-tags': {},
        versions: { '1.0.0': { name: 'mock-verify-incomplete', version: '1.0.0', dist: {} } },
      }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  try {
    const result = await runVerify('mock-verify-incomplete', '1.0.0', {
      VERIFY_DEADLINE_SECONDS: '3',
      VERIFY_INITIAL_INTERVAL_SECONDS: '1',
      VERIFY_MAX_INTERVAL_SECONDS: '1',
      VERIFY_ATTEMPTS: '2',
      VERIFY_NPM_REGISTRY: url,
      NPM_CONFIG_REGISTRY: url,
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Verified live/);
  } finally {
    await closeRegistry(server);
  }
});

test('live dry-run: already-published twzrd-x402-gate@0.16.1 (does not publish)', async () => {
  const result = await runVerify('twzrd-x402-gate', '0.16.1', {
    VERIFY_DEADLINE_SECONDS: '60',
    VERIFY_INITIAL_INTERVAL_SECONDS: '5',
    VERIFY_MAX_INTERVAL_SECONDS: '10',
    VERIFY_ATTEMPTS: '3',
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified live: twzrd-x402-gate@0\.16\.1/);
  assert.match(result.stdout, /twzrd-x402-gate-0\.16\.1\.tgz/);
});
