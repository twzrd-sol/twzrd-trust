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
// And for every workflow, publisher or not:
//
//   5. no run script contains a `${{ }}` expression. The runner expands an
//      expression into the script text before the shell parses it, so a
//      dispatch input such as `1.2.3$(command)` runs as a command. A value
//      reaches a script through `env:` and is read as "$NAME".
//
// One named exception: OIDC_CONSUMERS below. Such a workflow holds
// id-token: write to sign in to a service that is not a package registry, and
// starts from a comment, so rules 1, 2 and 4 cannot apply to it. It gets its
// own rules instead (oidcConsumerFindings): one trigger, one commenter, no
// write to contents or packages, no repository secret, no environment, no
// action but actions/checkout, no publish command, one OIDC audience, and the
// OIDC request variables removed from the step that runs the agent. A new
// name joins the list only by an edit to this file.
//
// What this file cannot prove: the environment's policy and the absence of a
// repository-level NPM_TOKEN are GitHub settings, and the npm-side trusted
// publisher binding is an npmjs.com setting. A workflow edited on a branch
// can drop step 2 and the environment; the environment policy and the npm
// binding are what stop it there.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Workflows that hold id-token: write and do not publish. Per file: the only
 * trigger, the only login whose comment starts a run, the only OIDC audience,
 * and the command that must run without the OIDC request variables.
 */
export const OIDC_CONSUMERS = {
  'opencode-review.yml': {
    trigger: 'issue_comment',
    login: 'twzrd-sol',
    audience: 'https://opencode.ai/console',
    agent: 'opencode github run',
  },
};
const PUBLISH_COMMAND = /\bnpm\s+(publish|token|login|adduser)\b|--provenance\b|\bdocker\s+(push|login)\b|\bgh\s+release\b|\bgit\s+push\b/;
const OIDC_REQUEST = /ACTIONS_ID_TOKEN_REQUEST_(TOKEN|URL)/;
const OIDC_UNSET = /\benv\s+-u\s+ACTIONS_ID_TOKEN_REQUEST_TOKEN\s+-u\s+ACTIONS_ID_TOKEN_REQUEST_URL\s+/;

const parsed = value => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

/**
 * The agent step's environment must make the agent read-only on its own:
 * opencode takes the agent from config (an AGENT variable is ignored), and
 * the run works on the pull request's branch, whose opencode.json would
 * otherwise be read.
 */
function readOnlyAgentFindings(at, env) {
  const findings = [];
  if (!['1', 'true'].includes(String(env.OPENCODE_DISABLE_PROJECT_CONFIG ?? ''))) {
    findings.push(`${at} reads the pull request's opencode config (OPENCODE_DISABLE_PROJECT_CONFIG is not set)`);
  }
  if (parsed(env.OPENCODE_CONFIG_CONTENT)?.default_agent !== 'plan') {
    findings.push(`${at} does not set the plan agent in OPENCODE_CONFIG_CONTENT`);
  }
  const permission = parsed(env.OPENCODE_PERMISSION);
  if (permission?.edit !== 'deny') findings.push(`${at} does not deny edits in OPENCODE_PERMISSION`);
  const bash = permission?.bash;
  const bashOk = bash === 'deny' || (bash !== null && typeof bash === 'object' && bash['*'] === 'deny'
    && Object.entries(bash).every(([pattern, action]) => action === 'deny' || /^git (diff|status|log|show)\*$/.test(pattern)));
  if (!bashOk) findings.push(`${at} lets the agent run shell commands other than read-only git in OPENCODE_PERMISSION`);
  return findings;
}

/** Every way an OIDC_CONSUMERS workflow breaks its rules. */
export function oidcConsumerFindings(file, doc, rule = OIDC_CONSUMERS[file]) {
  const findings = [];
  const on = doc.on ?? doc[true];
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  if (triggers.length !== 1 || triggers[0] !== rule.trigger) {
    findings.push(`${file}: triggers [${triggers.join(', ')}]; this workflow starts on ${rule.trigger} only`);
  }
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    if (!job || typeof job !== 'object') continue;
    const where = `${file} job ${name}`;
    const perms = permissionsOf(doc, job);
    if (typeof job.uses === 'string') {
      findings.push(`${where}: a reusable workflow; this check cannot see inside it`);
      continue;
    }
    for (const scope of ['contents', 'packages', 'actions', 'deployments', 'attestations']) {
      if (grants(perms, scope)) findings.push(`${where}: holds ${scope}: write`);
    }
    if (readsRepoSecret(doc, job)) findings.push(`${where}: reads a repository secret`);
    if (job.environment !== undefined) findings.push(`${where}: runs in an environment`);
    const gate = typeof job.if === 'string' ? job.if : '';
    if (!gate.includes(`github.event.comment.user.login == '${rule.login}'`) || /\|\|[^()]*github\.event\.comment\.user\.login/.test(gate)) {
      findings.push(`${where}: \`if:\` does not require the comment to come from ${rule.login}`);
    }
    if (!grants(perms, 'id-token')) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      const at = `${where}: step ${i + 1}`;
      if (typeof step?.uses === 'string') {
        if (!isCheckout(step)) findings.push(`${at} uses ${step.uses}; only actions/checkout may run beside the OIDC token`);
        for (const key of ['ref', 'repository']) {
          if (step.with && step.with[key] !== undefined && step.with[key] !== '') {
            findings.push(`${at} checks out \`${key}: ${step.with[key]}\``);
          }
        }
        return;
      }
      const text = JSON.stringify(step ?? {});
      if (PUBLISH_COMMAND.test(text)) findings.push(`${at} has a publish or push command`);
      const run = typeof step?.run === 'string' ? step.run : '';
      if (OIDC_REQUEST.test(run.replace(OIDC_UNSET, ''))) {
        if (!/audience=\$AUDIENCE\b/.test(run) || step.env?.AUDIENCE !== rule.audience) {
          findings.push(`${at} requests an OIDC token for an audience other than ${rule.audience}`);
        }
      }
      if (run.includes(rule.agent) && !OIDC_UNSET.test(run)) {
        findings.push(`${at} runs \`${rule.agent}\` with the OIDC request variables still set`);
      }
      if (run.includes(rule.agent)) findings.push(...readOnlyAgentFindings(at, step.env ?? {}));
    });
    if (!steps.some(step => typeof step?.run === 'string' && step.run.includes(rule.agent))) {
      findings.push(`${where}: no step runs \`${rule.agent}\``);
    }
  }
  return findings;
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
  if (Object.hasOwn(OIDC_CONSUMERS, file)) return oidcConsumerFindings(file, doc);

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

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/** Rule 5: every run script in `doc` that has an expression pasted into it. */
export function runExpressionFindings(file, doc) {
  const findings = [];
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (typeof step?.run !== 'string') return;
      for (const expression of step.run.match(EXPRESSION) ?? []) {
        findings.push(`${file} job ${name}: step ${i + 1} pastes ${expression} into its run script; pass it through env: and read "$NAME"`);
      }
    });
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

const CONSUMER = `
on:
  issue_comment:
    types: [created]
permissions: {}
jobs:
  review:
    if: github.event.issue.pull_request && github.event.comment.user.login == 'twzrd-sol'
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - env: { AUDIENCE: https://opencode.ai/console }
        run: curl --oauth2-bearer "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$AUDIENCE"
      - env:
          OPENCODE_DISABLE_PROJECT_CONFIG: "1"
          OPENCODE_CONFIG_CONTENT: '{"default_agent":"plan"}'
          OPENCODE_PERMISSION: '{"edit":"deny","bash":{"*":"deny","git diff*":"allow"}}'
        run: env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL opencode github run
`;
const consumer = (from, to) => {
  assert.ok(CONSUMER.includes(from), `fixture has no ${JSON.stringify(from)}`);
  return refGuardFindings('opencode-review.yml', yaml.load(CONSUMER.replace(from, to)));
};

test('checker: a listed OIDC consumer passes its own rules', () => {
  assert.deepEqual(refGuardFindings('opencode-review.yml', yaml.load(CONSUMER)), []);
});

test('checker: the same workflow under an unlisted name gets the publish rules', () => {
  const findings = refGuardFindings('other.yml', yaml.load(CONSUMER));
  assert.ok(findings.some(f => f.includes('starts on workflow_dispatch only')), findings.join('\n'));
  assert.ok(findings.some(f => f.includes(`outside the ${NPM_ENVIRONMENT} environment`)), findings.join('\n'));
});

test('checker: each broken OIDC consumer rule is reported', () => {
  const one = (from, to, want) => {
    const findings = consumer(from, to);
    assert.equal(findings.length, 1, `${want}: got ${JSON.stringify(findings)}`);
    assert.ok(findings[0].includes(want), `${want}: got ${findings[0]}`);
  };
  one('issue_comment:\n    types: [created]', 'pull_request_target: {}', 'starts on issue_comment only');
  one("&& github.event.comment.user.login == 'twzrd-sol'", '', 'does not require the comment to come from twzrd-sol');
  one("&& github.event.comment.user.login == 'twzrd-sol'", "|| github.event.comment.user.login == 'twzrd-sol'", 'does not require the comment to come from twzrd-sol');
  one('contents: read', 'contents: write', 'holds contents: write');
  one('pull-requests: write }', 'pull-requests: write, packages: write }', 'holds packages: write');
  one('    runs-on: ubuntu-latest', `    runs-on: ubuntu-latest\n    environment: ${NPM_ENVIRONMENT}`, 'runs in an environment');
  one('- uses: actions/checkout@v4', '- uses: actions/checkout@v4\n      - uses: someone/action@v1', 'only actions/checkout may run beside the OIDC token');
  one('- uses: actions/checkout@v4', '- uses: actions/checkout@v4\n        with: { ref: refs/pull/1/head }', 'checks out `ref: refs/pull/1/head`');
  one('- uses: actions/checkout@v4', '- uses: actions/checkout@v4\n      - run: npm publish --provenance', 'has a publish or push command');
  one('- uses: actions/checkout@v4', '- uses: actions/checkout@v4\n      - run: echo \${{ secrets.NPM_TOKEN }}', 'reads a repository secret');
  one('AUDIENCE: https://opencode.ai/console', 'AUDIENCE: npm:registry.npmjs.org', 'audience other than https://opencode.ai/console');
  one('&audience=$AUDIENCE', '&audience=npm:registry.npmjs.org', 'audience other than https://opencode.ai/console');
  one('env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL opencode', 'opencode', 'with the OIDC request variables still set');
  one('opencode github run', 'true', 'no step runs `opencode github run`');
  one('OPENCODE_DISABLE_PROJECT_CONFIG: "1"', 'OPENCODE_DISABLE_PROJECT_CONFIG: "0"', "reads the pull request's opencode config");
  one('{"default_agent":"plan"}', '{"default_agent":"build"}', 'does not set the plan agent');
  one('{"default_agent":"plan"}', 'not json', 'does not set the plan agent');
  one('"edit":"deny"', '"edit":"allow"', 'does not deny edits');
  one('"*":"deny"', '"*":"allow"', 'shell commands other than read-only git');
  one('"git diff*":"allow"', '"rm *":"allow"', 'shell commands other than read-only git');
  one('"bash":{"*":"deny","git diff*":"allow"}', '"bash":"allow"', 'shell commands other than read-only git');
});

test('checker: an expression in a run script is reported, one in env is not', () => {
  const doc = fixture({ steps: `${GUARD}
      - env:
          EXPECTED_VERSION: \${{ inputs.expected_version }}
        run: test "$EXPECTED_VERSION" = 1.2.3
      - run: |
          if [ "$ACTUAL" != "\${{ inputs.expected_version }}" ]; then exit 1; fi
      - run: bash verify.sh "\${{ steps.ver.outputs.expected }}" \${{github.event.inputs.tag}}` });
  assert.deepEqual(runExpressionFindings('x.yml', doc), [
    'x.yml job publish: step 3 pastes ${{ inputs.expected_version }} into its run script; pass it through env: and read "$NAME"',
    'x.yml job publish: step 4 pastes ${{ steps.ver.outputs.expected }} into its run script; pass it through env: and read "$NAME"',
    'x.yml job publish: step 4 pastes ${{github.event.inputs.tag}} into its run script; pass it through env: and read "$NAME"',
  ]);
});

// --- this repository -----------------------------------------------------------

const workflowNames = () => readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name)).sort();
const loadWorkflow = name => yaml.load(readFileSync(new URL(name, workflowsDir), 'utf8'));

test('every workflow that can publish is pinned to main', () => {
  const findings = workflowNames().flatMap(name => refGuardFindings(name, loadWorkflow(name)));
  assert.deepEqual(findings, []);
});

test('every listed OIDC consumer exists and holds id-token', () => {
  for (const name of Object.keys(OIDC_CONSUMERS)) {
    assert.ok(workflowNames().includes(name), `${name}: listed in OIDC_CONSUMERS but not in .github/workflows`);
    assert.ok(publishingJobs(loadWorkflow(name)).some(j => grants(permissionsOf(loadWorkflow(name), j.job), 'id-token')), `${name}: no job holds id-token: write; drop it from OIDC_CONSUMERS`);
    assert.ok(!KNOWN_PUBLISHERS.includes(name), `${name}: cannot be both a publisher and an OIDC consumer`);
  }
});

test('the checker still recognises every known publishing workflow', () => {
  const seen = workflowNames().filter(name => publishingJobs(loadWorkflow(name)).length > 0);
  for (const name of KNOWN_PUBLISHERS) {
    assert.ok(seen.includes(name), `${name}: no job recognised as holding a publish credential`);
  }
});

test('no run script in any workflow has an expression pasted into it', () => {
  const findings = workflowNames().flatMap(name => runExpressionFindings(name, loadWorkflow(name)));
  assert.deepEqual(findings, []);
});

// The version check, run the way the runner runs it: every expression in the
// script is replaced by its value before bash sees the text, and every
// expression in `env:` becomes a variable's value. A dispatch input carrying a
// command substitution must not run, and must not pass the check.
const VERSION_INPUT = /\$\{\{\s*(inputs\.expected_version|steps\.ver\.outputs\.expected)\s*\}\}/g;
const VERSION_CHECKS = {
  'publish.yml': { cwd: 'twzrd-x402-gate' },
  'publish-eliza-plugin.yml': { cwd: '.' },
};

function runVersionSteps(file, input) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-version-check-'));
  try {
    for (const sub of ['twzrd-x402-gate', 'eliza-plugin-source']) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }));
    }
    const job = loadWorkflow(file).jobs.publish;
    const render = env => Object.fromEntries(
      Object.entries(env ?? {})
        .filter(([, value]) => !String(value).includes('secrets.'))
        .map(([key, value]) => [key, String(value).replace(VERSION_INPUT, input)]),
    );
    const steps = job.steps.filter(step => typeof step.run === 'string'
      && (VERSION_INPUT.test(step.run) || step.run.includes('EXPECTED_VERSION'))
      && !step.run.includes('verify-live-npm-version.sh'));
    VERSION_INPUT.lastIndex = 0;
    assert.ok(steps.length > 0, `${file}: no step checks the expected version`);
    let out = '';
    for (const step of steps) {
      const script = step.run.replace(VERSION_INPUT, input);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        cwd: join(dir, VERSION_CHECKS[file].cwd),
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: join(dir, 'github-output'), ...render(job.env), ...render(step.env) },
        encoding: 'utf8',
      });
      out += result.stdout + result.stderr;
      if (result.status !== 0) return { passed: false, out, marker: existsSync(join(dir, 'injected-marker')) };
    }
    return { passed: true, out, marker: existsSync(join(dir, 'injected-marker')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const file of Object.keys(VERSION_CHECKS)) {
  test(`${file}: the version check passes the confirmed version and refuses another`, () => {
    const ok = runVersionSteps(file, '1.2.3');
    assert.equal(ok.passed, true, ok.out);
    assert.match(ok.out, /Confirmed: publishing/);
    assert.equal(runVersionSteps(file, '1.2.4').passed, false);
    assert.equal(runVersionSteps(file, '').passed, false);
  });

  test(`${file}: a dispatch input is never run as shell`, () => {
    const marker = join(tmpdir(), `publish-injected-${process.pid}`);
    const payloads = [
      '1.2.3$(touch injected-marker)',
      '1.2.3`touch injected-marker`',
      '1.2.3"; touch injected-marker; echo "',
      `1.2.3$(touch ${marker})`,
      '1.2.3\n::error::forged',
      '$(node -p "require(\'./package.json\').version")',
    ];
    try {
      for (const input of payloads) {
        const result = runVersionSteps(file, input);
        assert.equal(result.marker, false, `${JSON.stringify(input)} ran a command`);
        assert.equal(existsSync(marker), false, `${JSON.stringify(input)} ran a command`);
        assert.equal(result.passed, false, `${JSON.stringify(input)} passed the version check: ${result.out}`);
        assert.doesNotMatch(result.out, /Confirmed: publishing/);
      }
    } finally {
      rmSync(marker, { force: true });
    }
  });
}
