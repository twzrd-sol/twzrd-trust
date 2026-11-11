// Guards for every job that can publish from this repository.
//
// A job "can publish" when it holds id-token: write (npm trusted publishing),
// packages: write (GHCR), or reads a repository secret (NPM_TOKEN). Before
// this file, the npm publish workflows checked out whatever ref they were
// dispatched on and only compared package.json and HEAD to the dispatch
// inputs, so a branch nobody reviewed could be published with provenance.
// Each such job must now:
//
//   1. start only from workflow_dispatch (no push, tag, schedule or PR
//      trigger can reach the credential);
//   2. refuse any ref but refs/heads/main in a run step that comes before
//      everything except actions/checkout, and that cannot be skipped;
//   3. check out the dispatched commit itself (no `ref:` or `repository:`
//      override, which is how a run from main could build another branch);
//   4. for npm (OIDC or token), run in the `Npm_token` environment. Its
//      deployment policy allows main only, and GitHub enforces that on its
//      side, even for a workflow file someone edited on a branch. The job
//      reads the npm token from that environment; a repository-level
//      NPM_TOKEN is readable from any branch, so none should exist.
//
// What this file cannot prove: the environment's policy and the absence of a
// repository-level NPM_TOKEN are GitHub settings, and the npm-side trusted
// publisher binding is an npmjs.com setting. A workflow edited on a branch
// can drop step 2 and the environment; the environment policy and the npm
// binding are what stop it there.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const workflowsDir = new URL('.github/workflows/', root);
export const NPM_ENVIRONMENT = 'Npm_token';
const KNOWN_PUBLISHERS = [
  'agent-killswitch-image.yml',
  'publish-agent-killswitch.yml',
  'publish-eliza-plugin.yml',
  'publish-log-verifier.yml',
  'publish.yml',
];

// The repo root installs no YAML parser; agent-killswitch's js-yaml is
// installed by root `npm test` (test:agent-killswitch) before this file runs.
const yaml = (() => {
  try {
    return createRequire(new URL('agent-killswitch/package.json', root))('js-yaml');
  } catch {
    throw new Error(
      'js-yaml is not installed under agent-killswitch/node_modules. '
        + 'Run `npm ci --prefix agent-killswitch` first (root `npm test` does).',
    );
  }
})();

const MAIN_GUARD = /\[\s*"\$GITHUB_REF"\s*!=\s*"refs\/heads\/main"\s*\]/;
const REPO_SECRET = /\bsecrets\s*\.\s*(?!GITHUB_TOKEN\b)[A-Za-z_][A-Za-z0-9_]*/;

function permissionsOf(doc, job) {
  // A job-level block replaces the workflow-level one; it is not merged.
  return job.permissions !== undefined ? job.permissions : (doc.permissions ?? null);
}

function grants(perms, scope) {
  if (perms === 'write-all') return true;
  return perms !== null && typeof perms === 'object' && perms[scope] === 'write';
}

function readsRepoSecret(doc, job) {
  if (job.secrets === 'inherit') return true;
  return REPO_SECRET.test(JSON.stringify(job)) || REPO_SECRET.test(JSON.stringify(doc.env ?? {}));
}

function environmentName(job) {
  const env = job.environment;
  if (typeof env === 'string') return env;
  if (env && typeof env === 'object' && typeof env.name === 'string') return env.name;
  return null;
}

const isCheckout = step => typeof step?.uses === 'string' && /^actions\/checkout@/.test(step.uses);
const isMainGuard = step => typeof step?.run === 'string' && MAIN_GUARD.test(step.run) && /\bexit 1\b/.test(step.run);

/** The jobs in `doc` that can publish, with why. */
export function publishingJobs(doc) {
  const out = [];
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    if (!job || typeof job !== 'object') continue;
    const perms = permissionsOf(doc, job);
    const npm = grants(perms, 'id-token') || readsRepoSecret(doc, job);
    const ghcr = grants(perms, 'packages');
    if (npm || ghcr) out.push({ name, job, npm, ghcr });
  }
  return out;
}

/** Every way `doc` (workflow file `file`) breaks the four rules above. */
export function refGuardFindings(file, doc) {
  const findings = [];
  const jobs = publishingJobs(doc);
  if (jobs.length === 0) return findings;

  const on = doc.on ?? doc[true]; // js-yaml 1.1 schemas can read a bare `on` as true
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    findings.push(`${file}: triggers [${triggers.join(', ')}]; a workflow that can publish starts on workflow_dispatch only`);
  }

  for (const { name, job, npm } of jobs) {
    const where = `${file} job ${name}`;
    if (typeof job.uses === 'string') {
      findings.push(`${where}: a reusable workflow holds the credential; this check cannot see inside it`);
      continue;
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const guardAt = steps.findIndex(isMainGuard);
    if (guardAt === -1) {
      findings.push(`${where}: no run step refuses a ref other than refs/heads/main (and exits 1)`);
    } else {
      const guard = steps[guardAt];
      if (guard.if !== undefined) findings.push(`${where}: the main-ref guard has an \`if:\` and can be skipped`);
      if (guard['continue-on-error'] !== undefined && guard['continue-on-error'] !== false) {
        findings.push(`${where}: the main-ref guard has continue-on-error`);
      }
      steps.slice(0, guardAt).forEach((step, i) => {
        if (!isCheckout(step)) findings.push(`${where}: step ${i + 1} runs before the main-ref guard`);
      });
    }
    steps.forEach((step, i) => {
      if (!isCheckout(step)) return;
      for (const key of ['ref', 'repository']) {
        if (step.with && step.with[key] !== undefined && step.with[key] !== '') {
          findings.push(`${where}: step ${i + 1} checks out \`${key}: ${step.with[key]}\` instead of the dispatched commit`);
        }
      }
    });
    if (npm && environmentName(job) !== NPM_ENVIRONMENT) {
      findings.push(`${where}: publishes to npm outside the ${NPM_ENVIRONMENT} environment (found ${environmentName(job) ?? 'none'})`);
    }
  }
  return findings;
}

// --- the checker itself --------------------------------------------------------

const GUARD = `
      - name: Refuse unless dispatched from main
        run: |
          if [ "$GITHUB_REF" != "refs/heads/main" ]; then
            echo "::error::publishes from main only, got $GITHUB_REF -- refusing."
            exit 1
          fi`;

function fixture({ on = 'workflow_dispatch:', perms = '{ contents: read, id-token: write }', env = `environment: ${NPM_ENVIRONMENT}`, steps }) {
  return yaml.load(`
on:
  ${on}
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: ${perms}
    ${env}
    steps:${steps}
`);
}

test('checker: a guarded npm job in the environment passes', () => {
  const doc = fixture({ steps: `${GUARD}
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - run: npm publish --provenance` });
  assert.deepEqual(refGuardFindings('ok.yml', doc), []);
});

test('checker: checkout before the guard is allowed, anything else is not', () => {
  const doc = fixture({ perms: '{ contents: read, packages: write }', env: '', steps: `
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
${GUARD}` });
  assert.deepEqual(refGuardFindings('img.yml', doc), ['img.yml job publish: step 2 runs before the main-ref guard']);
});

test('checker: each broken rule is reported', () => {
  assert.deepEqual(
    refGuardFindings('noguard.yml', fixture({ steps: `
      - uses: actions/checkout@v4
      - run: npm publish` })),
    ['noguard.yml job publish: no run step refuses a ref other than refs/heads/main (and exits 1)'],
  );
  assert.deepEqual(
    refGuardFindings('tags.yml', fixture({ on: `workflow_dispatch:\n  push:\n    tags: ['v*']`, steps: GUARD })),
    ['tags.yml: triggers [workflow_dispatch, push]; a workflow that can publish starts on workflow_dispatch only'],
  );
  assert.deepEqual(
    refGuardFindings('ref.yml', fixture({ steps: `${GUARD}
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.source_ref }}` })),
    ['ref.yml job publish: step 2 checks out `ref: ${{ inputs.source_ref }}` instead of the dispatched commit'],
  );
  assert.deepEqual(
    refGuardFindings('noenv.yml', fixture({ env: '', steps: GUARD })),
    [`noenv.yml job publish: publishes to npm outside the ${NPM_ENVIRONMENT} environment (found none)`],
  );
  assert.deepEqual(
    refGuardFindings('skip.yml', fixture({ steps: GUARD.replace('run: |', 'if: false\n        run: |') })),
    ['skip.yml job publish: the main-ref guard has an `if:` and can be skipped'],
  );
});

test('checker: a repository secret makes a job an npm publisher even without id-token', () => {
  const doc = fixture({ perms: '{ contents: read }', env: '', steps: `${GUARD}
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}` });
  assert.deepEqual(refGuardFindings('tok.yml', doc), [
    `tok.yml job publish: publishes to npm outside the ${NPM_ENVIRONMENT} environment (found none)`,
  ]);
  const plain = fixture({ perms: '{ contents: read }', env: '', steps: `
      - run: echo \${{ secrets.GITHUB_TOKEN }}` });
  assert.deepEqual(publishingJobs(plain), [], 'GITHUB_TOKEN with contents: read is not a publish credential');
});

test('checker: workflow-level permissions count when the job sets none', () => {
  const doc = yaml.load(`
on: { workflow_dispatch: {} }
permissions: { id-token: write }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`);
  assert.equal(publishingJobs(doc).length, 1);
});

// --- this repository -----------------------------------------------------------

const workflowNames = () => readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name)).sort();
const loadWorkflow = name => yaml.load(readFileSync(new URL(name, workflowsDir), 'utf8'));

test('every workflow that can publish is pinned to main', () => {
  const findings = workflowNames().flatMap(name => refGuardFindings(name, loadWorkflow(name)));
  assert.deepEqual(findings, []);
});

test('the checker still recognises every known publishing workflow', () => {
  const seen = workflowNames().filter(name => publishingJobs(loadWorkflow(name)).length > 0);
  for (const name of KNOWN_PUBLISHERS) {
    assert.ok(seen.includes(name), `${name}: no job recognised as holding a publish credential`);
  }
});
