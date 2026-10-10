// E2E tests for following the package manager that launched the CLI, using the real pnpm CLI.
// pnpm must be on PATH; the pnpm tests are skipped otherwise.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeRegistry } from './helpers/fake-registry.js';
import { createSandbox, run, cliPath, npmCommand, pnpmCommand, packCli, findFilesContaining } from './helpers/sandbox.js';

const TOKEN = 'dummy-token-for-e2e-0123456789';
const pnpm = pnpmCommand([]);
let pnpmMajor = 0;

async function setup(t, registryOptions = { token: TOKEN }) {
  const registry = await startFakeRegistry(registryOptions);
  const sandbox = await createSandbox({ registryUrl: registry.url });
  t.after(async () => {
    await registry.close();
    await sandbox.cleanup();
  });
  const runCli = (args, extraEnv = {}) =>
    run(process.execPath, [cliPath, ...args, '--registry', registry.url], {
      env: { ...sandbox.env, ...extraEnv },
      cwd: sandbox.dirs.work
    });
  const runPnpm = (args, extraEnv = {}) => {
    const command = pnpmCommand(args);
    return run(command.command, command.args, { env: { ...sandbox.env, ...extraEnv }, cwd: sandbox.dirs.work });
  };
  return { registry, sandbox, runCli, runPnpm };
}

const publishRequests = (registry) => registry.requests.filter((request) => request.method === 'PUT');

// pnpm 11+ publishes natively and always sends its own `pnpm/...` user agent.
// npm (and pnpm 10, which publishes through npm) copies npm_config_user_agent into the header instead,
// so the registry side can tell them apart only with pnpm 11+.
function assertSentBy(registry, packageManager) {
  if (pnpmMajor < 11) return;
  const userAgent = publishRequests(registry)[0].headers['user-agent'];
  if (packageManager === 'pnpm') {
    assert.match(userAgent, /^pnpm\//);
  } else {
    assert.doesNotMatch(userAgent, /^pnpm\//);
  }
}

before(async () => {
  if (!pnpm) return;
  const sandbox = await createSandbox({ registryUrl: 'http://127.0.0.1:9/' });
  try {
    const version = await run(pnpm.command, [...pnpm.args, '--version'], { env: sandbox.env, cwd: sandbox.dirs.work });
    pnpmMajor = Number(version.stdout.trim().split('.')[0]);
  } finally {
    await sandbox.cleanup();
  }
});

describe('package manager detection', () => {
  const cases = [
    { name: 'no user agent (direct run)', env: {}, expected: 'npm' },
    { name: 'npm user agent (npx)', env: { npm_config_user_agent: 'npm/10.9.4 node/v22.22.0 linux x64 workspaces/false' }, expected: 'npm' },
    { name: 'yarn user agent', env: { npm_config_user_agent: 'yarn/4.5.0 npm/? node/v22.22.0 linux x64' }, expected: 'npm' },
    { name: 'bun user agent', env: { npm_config_user_agent: 'bun/1.2.0 npm/? node/v22.22.0 linux x64' }, expected: 'npm' },
    { name: 'pnpm user agent without npm_execpath (pnpm 10 dlx)', env: { npm_config_user_agent: 'pnpm/10.28.0 npm/? node/v22.22.0 linux x64' }, expected: 'pnpm' },
    { name: 'npm user agent with npm_execpath pointing to pnpm', env: { npm_config_user_agent: 'npm/10.9.4 node/v22.22.0 linux x64 workspaces/false', npm_execpath: pnpm?.args[0] ?? pnpm?.command ?? '' }, expected: 'npm' }
  ];
  for (const { name, env, expected } of cases) {
    test(`${name} -> ${expected}`, { skip: expected === 'pnpm' && !pnpm && 'pnpm is not installed' }, async (t) => {
      const { registry, runCli } = await setup(t);
      const result = await runCli([`detect-${expected}`], { ...env, NPM_TOKEN: TOKEN });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Package manager: ${expected}\\n`));
      assert.match(result.stdout, new RegExp(`Publishing package to npm with ${expected}`));
      assert.equal(registry.publishes.length, 1);
      assert.equal(registry.publishes[0].headers.authorization, `Bearer ${TOKEN}`);
      assertSentBy(registry, expected);
    });
  }

  test('fails without falling back to npm when pnpm cannot be found', async (t) => {
    const { registry, sandbox, runCli } = await setup(t);
    const emptyBin = join(sandbox.root, 'empty-bin');
    await mkdir(emptyBin);
    const result = await runCli(['pnpm-missing'], {
      PATH: emptyBin,
      Path: emptyBin,
      npm_config_user_agent: 'pnpm/11.0.0 npm/? node/v22.22.0 linux x64',
      NPM_TOKEN: TOKEN
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /pnpm was not found/);
    assert.deepEqual(registry.requests, []);
  });

  test('--dry-run shows the pnpm command and does not contact the registry', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['@e2e-scope/dry-run', '--dry-run'], {
      npm_config_user_agent: 'pnpm/11.0.0 npm/? node/v22.22.0 linux x64',
      NPM_TOKEN: TOKEN
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /pnpm publish --registry \S+ --no-git-checks --access public/);
    assert.deepEqual(registry.requests, []);
  });
});

describe('launched with pnpm dlx', { skip: !pnpm && 'pnpm is not installed' }, () => {
  let tarball;
  let packSandbox;
  before(async () => {
    packSandbox = await createSandbox({ registryUrl: 'http://127.0.0.1:9/' });
    tarball = await packCli(packSandbox);
  });
  after(() => packSandbox.cleanup());

  const dlx = (runPnpm, args, env) => runPnpm(['dlx', tarball, ...args], env);

  test('publishes the placeholder with pnpm and NPM_TOKEN', async (t) => {
    const { registry, sandbox, runPnpm } = await setup(t);
    const result = await dlx(runPnpm, ['@e2e-scope/via-pnpm', '--registry', registry.url, '--access', 'restricted'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Package manager: pnpm\n/);
    assert.equal(publishRequests(registry).length, 1);
    const [publish] = registry.publishes;
    assert.equal(publish.name, '@e2e-scope/via-pnpm');
    assert.equal(publish.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(publish.body.access, 'restricted');
    assertSentBy(registry, 'pnpm');
    const packageJson = JSON.parse(publish.attachments[0].files['package/package.json']);
    assert.equal(packageJson.name, '@e2e-scope/via-pnpm');
    assert.equal(packageJson.version, '0.0.0');
    assert.match(publish.attachments[0].files['package/README.md'], /^# @e2e-scope\/via-pnpm\n/);
    assert.deepEqual(await findFilesContaining(sandbox.root, TOKEN), []);
  });

  test('uses the credentials saved by `pnpm login`', async (t) => {
    const { registry, sandbox, runPnpm } = await setup(t);
    const login = await runPnpm(['login', '--registry', registry.url]);
    assert.equal(login.code, 0, login.stderr);

    const result = await dlx(runPnpm, ['after-pnpm-login', '--registry', registry.url]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Using NPM_TOKEN/);
    assert.equal(registry.publishes[0].headers.authorization, `Bearer ${TOKEN}`);
    assertSentBy(registry, 'pnpm');

    // pnpm 11+ saves the login in pnpm's own config, which npm does not read: this is why the CLI follows pnpm.
    if (pnpmMajor >= 11) {
      const npx = npmCommand(['exec', '--yes', `--package=${tarball}`, '--', 'setup-npm-trusted-publish', 'npx-after-pnpm-login', '--registry', registry.url]);
      const npxResult = await run(npx.command, npx.args, { env: sandbox.env, cwd: sandbox.dirs.work });
      assert.equal(npxResult.code, 1);
      assert.match(npxResult.stdout, /Package manager: npm\n/);
      assert.equal(registry.publishes.length, 1);
    }
  });

  test('does not retry with npm when the version was already published', async (t) => {
    const { registry, runPnpm } = await setup(t, { token: TOKEN, published: { 'pnpm-already-there': ['0.0.0'] } });
    const result = await dlx(runPnpm, ['pnpm-already-there', '--registry', registry.url], { NPM_TOKEN: TOKEN });

    // At most one PUT: no retry. pnpm 10 publishes through npm, and npm 11 refuses an existing version without a PUT.
    assert.ok(publishRequests(registry).length <= 1);
    assert.equal(registry.publishes.length, 0);
    assertSentBy(registry, 'pnpm');
    if (pnpmMajor === 11) {
      // pnpm 11 prints this error to stdout, which stays attached to the terminal (OTP prompts need it), so the CLI cannot recognize it.
      assert.equal(result.code, 1);
      assert.match(result.stdout, /cannot publish over the previously published versions/);
    } else {
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /was previously published .*Skipping placeholder publish/);
    }
  });

  test('does not retry with npm when the registry rejects the token', async (t) => {
    const { registry, runPnpm } = await setup(t);
    const result = await dlx(runPnpm, ['pnpm-bad-token', '--registry', registry.url], { NPM_TOKEN: 'wrong-token' });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Failed to publish placeholder package/);
    assert.equal(publishRequests(registry).length, 1);
    assert.equal(registry.publishes.length, 0);
    assertSentBy(registry, 'pnpm');
  });

  test('--dry-run does not contact the registry', async (t) => {
    const { registry, runPnpm } = await setup(t);
    const result = await dlx(runPnpm, ['pnpm-dry-run', '--registry', registry.url, '--dry-run'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /pnpm publish --registry \S+ --no-git-checks/);
    assert.deepEqual(publishRequests(registry), []);
  });
});
