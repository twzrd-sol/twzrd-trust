// Guards for the agent-killswitch release path.
//
// agent-killswitch/test/binding-plane.test.mjs proves that the gate and the
// proxy read the same .pause file, so two of its tests import
// ../twzrd-x402-gate/dist. Two rules follow, and both have to survive edits
// to workflow files that only ever run on release day:
//
//   1. A job that runs the agent-killswitch suite builds the gate first.
//      The 0.1.8 publish run failed with ERR_MODULE_NOT_FOUND because the
//      release workflow ran the suite without the gate build root CI does.
//   2. A job that holds a release credential (id-token: write for npm,
//      packages: write for GHCR) does not run that suite, install the
//      repo-root tree or build the gate. Running the cross-reader tests
//      executes the gate's dependencies; the proxy has one runtime
//      dependency of its own. The suite runs in a separate job the release
//      job needs.
//
// This is a tripwire for the shapes this repo uses (npm scripts and
// `node --test` in `run:` blocks), not a proof. It does not look inside
// composite actions or other reusable workflows and knows no other package
// manager. The release job's `uses:` allowlist and trigger checks below are
// what catch those.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const workflowsDir = new URL('.github/workflows/', root);
const KILLSWITCH = 'agent-killswitch';
const GATE = 'twzrd-x402-gate';
const CONFORMANCE = 'agent-killswitch-conformance.yml';
const CONFORMANCE_REF = `./.github/workflows/${CONFORMANCE}`;
const RELEASE_WORKFLOWS = ['publish-agent-killswitch.yml', 'agent-killswitch-image.yml'];

const read = url => readFileSync(url, 'utf8');

// The repo root installs no YAML parser. js-yaml is agent-killswitch's own
// dependency, and root `npm test` runs test:agent-killswitch (which installs
// it) before this file.
const yaml = (() => {
  try {
    return createRequire(new URL(`${KILLSWITCH}/package.json`, root))('js-yaml');
  } catch {
    throw new Error(
      `js-yaml is not installed under ${KILLSWITCH}/node_modules. `
        + `Run \`npm ci --prefix ${KILLSWITCH}\` first (root \`npm test\` does).`,
    );
  }
})();

const unquote = word => word.replace(/^(['"])(.*)\1$/, '$2');
function normDir(dir) {
  const n = path.posix.normalize(String(dir ?? '.')).replace(/\/+$/, '');
  return n === '' ? '.' : n;
}

/** Shell commands of a `run:` block, one per entry, comments dropped. */
function commandsOf(script) {
  const lines = [];
  let heredocEnd = null;
  for (const line of String(script).replace(/\\\n/g, ' ').split('\n')) {
    if (heredocEnd !== null) {
      // A heredoc body is data, not commands.
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const heredoc = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    if (heredoc) heredocEnd = heredoc[2];
    lines.push(line);
  }
  return lines
    .flatMap(line => line.split(/&&|\|\|?|;/))
    .map(command => command
      .replace(/\s\d*(?:>>?|<)&?\s*\S+/g, ' ')
      .trim()
      .replace(/^(?:(?:if|then|else|elif|do|time|exec|!)\s+|\w+=\S*\s+)+/, ''))
    .filter(Boolean);
}

/** What one command does, given the directory it runs in. */
function classify(command, cwd) {
  let dir = cwd;
  const rest = command.replace(/\s--prefix(?:=|\s+)(\S+)/, (_, prefix) => {
    dir = normDir(path.posix.join(cwd, unquote(prefix)));
    return '';
  });
  const npmRun = name => new RegExp(`^npm\\s+(?:run|run-script)\\s+${name}(?=\\s|$)`).test(rest);
  const bareNpmTest = /^npm\s+(?:test|t)(?=\s|$)/.test(rest);

  // Root `npm test` and `npm run ci` build the gate, then run every suite
  // (asserted against package.json below). Arguments after `--` go to the
  // scripts; a workspace selector means the root script does not run.
  const beforeDashDash = rest.split(/\s--(?=\s|$)/)[0].trim();
  const rootAggregate = dir === '.'
    && /^npm\s+(?:test|t|(?:run|run-script)\s+(?:ci|test))$/.test(beforeDashDash);
  const buildsGate = rootAggregate
    || (dir === '.' && /^npm\s+(?:run|run-script)\s+build(?:\s+(?:--workspace|-w)(?:=|\s+)twzrd-x402-gate)?\s*$/.test(rest))
    || (dir === GATE && /^npm\s+(?:run|run-script)\s+build\s*$/.test(rest));
  const runsSuite = rootAggregate
    || (dir === KILLSWITCH && (bareNpmTest || npmRun('ci') || npmRun('test') || /^node\s(?:.*\s)?--test(?=\s|$)/.test(rest)))
    || (dir === '.' && (npmRun('test:agent-killswitch') || /^node\s(?:.*\s)?--test\s(?:.*\s)?(?:\.\/)?agent-killswitch\//.test(rest)));
  const installsRoot = dir === '.'
    && /^npm\s+(?:ci|install|i)(?=\s|$)/.test(rest)
    && !/\s(?:-g|--global)(?=\s|$)/.test(rest);
  return { buildsGate, runsSuite, installsRoot };
}

/** Every job of a parsed workflow, with what its steps do, in order. */
function jobsOf(doc) {
  return Object.entries(doc?.jobs ?? {}).map(([name, job]) => {
    const suiteRuns = [];
    const rootInstalls = [];
    const gateBuilds = [];
    let gateBuilt = false;
    (job.steps ?? []).forEach((step, index) => {
      if (typeof step.run !== 'string') return;
      let cwd = normDir(
        step['working-directory']
          ?? job.defaults?.run?.['working-directory']
          ?? doc.defaults?.run?.['working-directory'],
      );
      const label = step.name ?? `step ${index}`;
      let builtInThisStep = false;
      for (const command of commandsOf(step.run)) {
        const cd = /^cd\s+(\S+)\s*$/.exec(command);
        if (cd) {
          cwd = normDir(path.posix.join(cwd, unquote(cd[1])));
          continue;
        }
        const does = classify(command, cwd);
        if (does.installsRoot) rootInstalls.push(`${label}: ${command}`);
        if (does.buildsGate) {
          gateBuilds.push(`${label}: ${command}`);
          builtInThisStep = true;
          // A build step behind `if:` may not run; it only covers its own step.
          if (!('if' in step)) gateBuilt = true;
        }
        if (does.runsSuite) {
          suiteRuns.push({ step: label, command, gateBuilt: gateBuilt || builtInThisStep });
        }
      }
    });
    return {
      name,
      uses: typeof job.uses === 'string' ? job.uses : null,
      needs: [].concat(job.needs ?? []),
      permissions: job.permissions ?? doc.permissions ?? null,
      condition: job.if ?? null,
      secrets: job.secrets ?? null,
      actions: (job.steps ?? []).filter(step => typeof step.uses === 'string').map(step => step.uses),
      suiteRuns,
      rootInstalls,
      gateBuilds,
    };
  });
}

const holdsReleaseCredential = permissions => permissions === 'write-all'
  || (permissions !== null && typeof permissions === 'object'
    && (permissions['id-token'] === 'write' || permissions.packages === 'write'));

const workflowNames = () => readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name)).sort();
const loadWorkflow = name => yaml.load(read(new URL(name, workflowsDir)));

// --- the reader itself ------------------------------------------------------

const job = body => `jobs:\n  j:\n    runs-on: ubuntu-latest\n${body}`;
const READER_CASES = [
  ['build step, then the suite in agent-killswitch', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - working-directory: .
        run: npm run build
      - run: npm run ci
  `), [true]],
  ['no build step', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - run: npm ci
      - run: npm run ci
  `), [false]],
  ['a step only named after the build', job(`
    steps:
      - name: Skip npm run build
        run: echo skipped
      - run: npm run test:agent-killswitch
  `), [false]],
  ['a different script that starts with "build"', job(`
    steps:
      - run: npm run build:docs
      - run: npm run test:agent-killswitch
  `), [false]],
  ['a build step behind `if:`', job(`
    steps:
      - if: false
        run: npm run build
      - run: npm run test:agent-killswitch
  `), [false]],
  ['a build in agent-killswitch is not the gate build', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - run: npm run build
      - run: npm test
  `), [false]],
  ['build and suite in one step', job(`
    steps:
      - run: npm ci --ignore-scripts && npm run build && npm run test:agent-killswitch
  `), [true]],
  ['quoted working-directory', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - working-directory: '.'
        run: npm run build
      - run: npm run ci
  `), [true]],
  ['cd into the package', job(`
    steps:
      - run: cd agent-killswitch && npm run ci
  `), [false]],
  ['--prefix before the subcommand', job(`
    steps:
      - run: npm --prefix agent-killswitch test
  `), [false]],
  ['--prefix after the subcommand', job(`
    steps:
      - run: npm run build
      - run: npm ci --prefix agent-killswitch && npm run ci --prefix agent-killswitch
  `), [true]],
  ['node --test on the package from the root', job(`
    steps:
      - run: node --test agent-killswitch/test/*.test.mjs
  `), [false]],
  ['root `npm run ci` builds first by itself', job(`
    steps:
      - run: npm run ci
  `), [true]],
  ['root `npm test` with arguments after `--`', job(`
    steps:
      - run: npm test -- --test-reporter=spec
  `), [true]],
  ['the suite behind a pipe and a redirection', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - run: npm run ci 2>&1 | tee out.log
  `), [false]],
  ['a heredoc body is not a command', job(`
    steps:
      - run: |
          cat > notes.txt <<'EOF'
          npm run test:agent-killswitch
          EOF
          echo done
  `), []],
  ['workspace scripts are not the root script', job(`
    steps:
      - run: npm run test --workspaces
  `), []],
  ['`npm ci` is an install, not the suite', job(`
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - run: npm ci
      - run: npm run typecheck
  `), []],
  ['another workspace is not the suite', job(`
    steps:
      - run: npm test --workspace=twzrd-x402-gate
  `), []],
];

for (const [title, text, expected] of READER_CASES) {
  test(`reader: ${title}`, () => {
    const [parsed] = jobsOf(yaml.load(text));
    assert.deepEqual(parsed.suiteRuns.map(run => run.gateBuilt), expected);
  });
}

test('reader: release credentials and root installs', () => {
  const [parsed] = jobsOf(yaml.load(job(`
    permissions: { contents: read, id-token: write }
    defaults: { run: { working-directory: agent-killswitch } }
    steps:
      - run: npm ci
      - run: npm install -g npm@11
      - working-directory: .
        run: npm ci --ignore-scripts
  `)));
  assert.equal(holdsReleaseCredential(parsed.permissions), true);
  assert.deepEqual(parsed.rootInstalls, ['step 2: npm ci --ignore-scripts']);
  assert.equal(parsed.condition, null);
  const [conditional] = jobsOf(yaml.load(job(`
    if: always()
    secrets: inherit
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local
  `)));
  assert.equal(conditional.condition, 'always()');
  assert.equal(conditional.secrets, 'inherit');
  assert.deepEqual(conditional.actions, ['actions/checkout@v4', './.github/actions/local']);
  assert.equal(holdsReleaseCredential({ contents: 'read' }), false);
  assert.equal(holdsReleaseCredential({ contents: 'read', packages: 'write' }), true);
  assert.equal(holdsReleaseCredential(null), false);
});

// --- this repository ---------------------------------------------------------

test('the scripts the reader relies on still mean what it assumes', () => {
  const pkg = JSON.parse(read(new URL('package.json', root)));
  assert.match(pkg.scripts.build, /^npm run build --workspace=twzrd-x402-gate$/);
  assert.match(pkg.scripts.test, /^npm run build && /);
  assert.match(pkg.scripts.ci, /^npm run build && /);
  assert.match(pkg.scripts['test:agent-killswitch'], /npm run ci --prefix agent-killswitch$/);
  const gate = JSON.parse(read(new URL(`${GATE}/package.json`, root)));
  assert.match(gate.scripts.build, /\btsc\b/);
  const killswitch = JSON.parse(read(new URL(`${KILLSWITCH}/package.json`, root)));
  assert.match(killswitch.scripts.ci, /\bnpm test\b/);
});

test('an agent-killswitch test still imports the gate build (the reason for these guards)', () => {
  const dir = new URL(`${KILLSWITCH}/test/`, root);
  const importers = readdirSync(dir).filter(name => /twzrd-x402-gate\/dist\b/.test(read(new URL(name, dir))));
  assert.notDeepEqual(
    importers,
    [],
    'no agent-killswitch test imports twzrd-x402-gate/dist any more: the conformance job no longer '
      + 'needs the gate build, and this file and that step can be simplified',
  );
});

test('every job that runs the agent-killswitch suite builds the gate first', () => {
  const seen = new Set();
  const missing = [];
  for (const name of workflowNames()) {
    for (const parsed of jobsOf(loadWorkflow(name))) {
      for (const run of parsed.suiteRuns) {
        seen.add(name);
        if (!run.gateBuilt) missing.push(`${name} job ${parsed.name}: ${run.step}: ${run.command}`);
      }
    }
  }
  for (const name of ['ci.yml', CONFORMANCE]) {
    assert.ok(seen.has(name), `${name}: no step recognised as running the agent-killswitch suite`);
  }
  assert.deepEqual(missing, [], 'these steps need a repo-root `npm run build` before them');
});

test('no job that holds a release credential runs the agent-killswitch suite', () => {
  const offenders = [];
  for (const name of workflowNames()) {
    for (const parsed of jobsOf(loadWorkflow(name))) {
      if (holdsReleaseCredential(parsed.permissions) && parsed.suiteRuns.length > 0) {
        offenders.push(`${name} job ${parsed.name}: ${parsed.suiteRuns.map(run => run.command).join(', ')}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the conformance workflow is callable, runs the suite and holds no credential', () => {
  const doc = loadWorkflow(CONFORMANCE);
  assert.ok(doc.on && typeof doc.on === 'object' && 'workflow_call' in doc.on, 'on.workflow_call is missing');
  // pull_request runs PR code with a read-only token; pull_request_target would not.
  assert.deepEqual(Object.keys(doc.on).sort(), ['pull_request', 'workflow_call']);
  assert.deepEqual(doc.permissions, { contents: 'read' });
  const parsedJobs = jobsOf(doc);
  for (const parsed of parsedJobs) {
    assert.deepEqual(parsed.permissions, { contents: 'read' }, `job ${parsed.name} widens the workflow permissions`);
  }
  assert.ok(parsedJobs.some(parsed => parsed.suiteRuns.length > 0), 'no job runs the agent-killswitch suite');
});

for (const name of RELEASE_WORKFLOWS) {
  test(`${name}: the release job needs conformance and stays off the gate`, () => {
    const doc = loadWorkflow(name);
    assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch'], 'a release workflow is started by a person only');
    const parsedJobs = jobsOf(doc);
    const conformance = parsedJobs.filter(parsed => parsed.uses === CONFORMANCE_REF);
    assert.equal(conformance.length, 1, `expected one job that uses ${CONFORMANCE_REF}`);
    assert.deepEqual(conformance[0].permissions, { contents: 'read' });
    assert.equal(conformance[0].secrets, null, 'the conformance job is handed no secrets');
    assert.equal(conformance[0].condition, null, 'the conformance job must always run');
    assert.deepEqual(
      parsedJobs.filter(parsed => parsed.uses !== null).map(parsed => parsed.uses),
      [CONFORMANCE_REF],
      'no other reusable workflow: this file cannot see inside one',
    );

    const release = parsedJobs.filter(parsed => holdsReleaseCredential(parsed.permissions));
    assert.equal(release.length, 1, 'expected exactly one job holding a release credential');
    const [releaseJob] = release;
    assert.notEqual(releaseJob.name, conformance[0].name);
    assert.ok(
      releaseJob.needs.includes(conformance[0].name),
      `job ${releaseJob.name} must need ${conformance[0].name}`,
    );
    assert.equal(
      releaseJob.condition,
      null,
      'a job-level `if:` (always(), !cancelled()) would let the release job run after conformance failed',
    );
    assert.deepEqual(
      releaseJob.actions.filter(action => !/^actions\/(?:checkout|setup-node)@/.test(action)),
      [],
      'the release job uses only checkout and setup-node: this file cannot see inside another action',
    );
    assert.deepEqual(releaseJob.suiteRuns, [], 'the release job must not run the suite');
    assert.deepEqual(releaseJob.rootInstalls, [], 'the release job must not install the repo-root tree');
    assert.deepEqual(releaseJob.gateBuilds, [], 'the release job must not build the gate');
  });
}
