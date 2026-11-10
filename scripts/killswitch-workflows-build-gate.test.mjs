// Every workflow job that runs the agent-killswitch tests must build
// twzrd-x402-gate first.
//
// agent-killswitch/test/binding-plane.test.mjs proves that the gate and the
// proxy read the same .pause file, so it imports ../twzrd-x402-gate/dist.
// Root `npm run ci` builds the gate before those tests. The two release
// workflows install and test agent-killswitch on its own, and the 0.1.8
// publish run failed at "Typecheck and test" with ERR_MODULE_NOT_FOUND
// because nothing had built the gate. This test keeps the three in step.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const workflowsDir = new URL('.github/workflows/', root);
const killswitchTestDir = new URL('agent-killswitch/test/', root);

const read = url => readFileSync(url, 'utf8');
const withoutComments = lines => lines.filter(line => !/^\s*#/.test(line)).join('\n');

/** Killswitch test files that import the gate's build output. */
function gateDistImporters() {
  return readdirSync(killswitchTestDir)
    .filter(name => /\.(mjs|cjs|js|ts)$/.test(name))
    .filter(name => /twzrd-x402-gate\/dist\//.test(read(new URL(name, killswitchTestDir))));
}

/**
 * A line-based reading of a workflow file: jobs, each with its default
 * working directory and its steps. Enough for the workflows in this repo,
 * which all indent jobs by two spaces and steps by six.
 */
function parseJobs(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return [];
  const jobs = [];
  let job = null;
  let step = null;
  let inSteps = false;
  for (const line of lines.slice(jobsAt + 1)) {
    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      job = { name: jobStart[1], defaultDir: '.', steps: [] };
      jobs.push(job);
      step = null;
      inSteps = false;
      continue;
    }
    if (!job) continue;
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) {
      const dir = /^\s+working-directory:\s*(\S+)\s*$/.exec(line);
      if (dir) job.defaultDir = dir[1];
      continue;
    }
    if (/^ {6}- /.test(line)) {
      step = { lines: [], dir: null };
      job.steps.push(step);
    }
    if (!step) continue;
    step.lines.push(line);
    const dir = /^ {8}working-directory:\s*(\S+)\s*$/.exec(line);
    if (dir) step.dir = dir[1];
  }
  for (const j of jobs) {
    for (const s of j.steps) {
      s.dir = s.dir ?? j.defaultDir;
      s.commands = withoutComments(s.lines);
    }
  }
  return jobs;
}

const atRoot = step => step.dir === '.' || step.dir === './';
const inKillswitch = step => /^(\.\/)?agent-killswitch\/?$/.test(step.dir);

/** The step runs the killswitch suite without building the gate itself. */
function runsKillswitchTests(step) {
  if (inKillswitch(step)) return /\bnpm (run ci|run test|test)\b/.test(step.commands);
  return /\btest:agent-killswitch\b/.test(step.commands)
    || /\bnpm (run ci|run test|test)\b[^\n]*--prefix[ =]agent-killswitch\b/.test(step.commands);
}

/** Root `npm run build` is the gate build (asserted below). */
function buildsGate(step) {
  return atRoot(step) && /\bnpm run build\b/.test(step.commands);
}

function findings() {
  const out = [];
  for (const name of readdirSync(workflowsDir).filter(n => /\.ya?ml$/.test(n)).sort()) {
    for (const job of parseJobs(read(new URL(name, workflowsDir)))) {
      job.steps.forEach((step, index) => {
        if (!runsKillswitchTests(step)) return;
        out.push({
          workflow: name,
          job: job.name,
          gateBuiltFirst: job.steps.slice(0, index).some(buildsGate),
        });
      });
    }
  }
  return out;
}

test('root `npm run build` builds twzrd-x402-gate', () => {
  const pkg = JSON.parse(read(new URL('package.json', root)));
  assert.match(pkg.scripts.build, /--workspace=twzrd-x402-gate\b/);
  const gate = JSON.parse(read(new URL('twzrd-x402-gate/package.json', root)));
  assert.match(gate.scripts.build, /\btsc\b/);
});

test('the reader finds the killswitch test step in CI and in both release workflows', () => {
  const seen = new Set(findings().map(f => f.workflow));
  for (const name of ['ci.yml', 'publish-agent-killswitch.yml', 'agent-killswitch-image.yml']) {
    assert.ok(seen.has(name), `${name}: no step recognised as running the agent-killswitch tests`);
  }
});

test('every workflow job that runs the agent-killswitch tests builds the gate first', t => {
  const importers = gateDistImporters();
  if (importers.length === 0) {
    t.skip('no agent-killswitch test imports twzrd-x402-gate/dist');
    return;
  }
  const missing = findings().filter(f => !f.gateBuiltFirst).map(f => `${f.workflow} (job ${f.job})`);
  assert.deepEqual(
    missing,
    [],
    `${importers.join(', ')} import twzrd-x402-gate/dist, so these jobs need a repo-root `
      + '`npm run build` step before the agent-killswitch tests',
  );
});
