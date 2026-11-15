// E2E tests that run the CLI with the real npm CLI against a local fake registry.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeRegistry } from './helpers/fake-registry.js';
import { createSandbox, run, cliPath, npmCommand, packCli, findFilesContaining } from './helpers/sandbox.js';

const TOKEN = 'dummy-token-for-e2e-0123456789';

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
  return { registry, sandbox, runCli };
}

const publishRequests = (registry) => registry.requests.filter((request) => request.method === 'PUT');

describe('npm publish via fake registry', () => {
  test('publishes the placeholder package with NPM_TOKEN', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['my-placeholder'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Using NPM_TOKEN for authentication/);
    assert.match(result.stdout, /Successfully published: my-placeholder/);

    assert.equal(publishRequests(registry).length, 1);
    const [publish] = registry.publishes;
    assert.equal(publish.name, 'my-placeholder');
    assert.equal(publish.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(publish.headers['user-agent'], /^npm\//);
    assert.deepEqual(Object.keys(publish.body.versions), ['0.0.0']);
    assert.equal(publish.body['dist-tags'].latest, '0.0.0');

    const [attachment] = publish.attachments;
    assert.deepEqual(Object.keys(attachment.files).sort(), ['package/README.md', 'package/package.json']);
    const packageJson = JSON.parse(attachment.files['package/package.json']);
    assert.deepEqual(packageJson, {
      name: 'my-placeholder',
      version: '0.0.0',
      description: 'OIDC trusted publishing setup package for my-placeholder',
      keywords: ['oidc', 'trusted-publishing', 'setup']
    });
    assert.match(attachment.files['package/README.md'], /^# my-placeholder\n/);
    assert.match(attachment.files['package/README.md'], /This package is created solely for the purpose of setting up OIDC/);
  });

  test('publishes a scoped package with --access and --package-version', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['@e2e-scope/pkg', '--access', 'restricted', '--package-version', '1.2.3'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(publishRequests(registry)[0].url, '/@e2e-scope%2fpkg');
    const [publish] = registry.publishes;
    assert.equal(publish.body.access, 'restricted');
    assert.deepEqual(Object.keys(publish.body.versions), ['1.2.3']);
    assert.equal(JSON.parse(publish.attachments[0].files['package/package.json']).version, '1.2.3');
  });

  test('does not write NPM_TOKEN to disk', async (t) => {
    const { sandbox, runCli } = await setup(t);
    const result = await runCli(['no-token-on-disk'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await findFilesContaining(sandbox.root, TOKEN), []);
  });

  test('uses the credentials saved by `npm login` when NPM_TOKEN is not set', async (t) => {
    const { registry, sandbox, runCli } = await setup(t);
    const npm = npmCommand(['login', '--registry', registry.url]);
    const login = await run(npm.command, npm.args, { env: sandbox.env, cwd: sandbox.dirs.work });
    assert.equal(login.code, 0, login.stderr);

    const result = await runCli(['after-npm-login']);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Using NPM_TOKEN/);
    assert.equal(registry.publishes[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  test('skips when the version was already published', async (t) => {
    const { registry, runCli } = await setup(t, { token: TOKEN, published: { 'already-there': ['0.0.0'] } });
    const result = await runCli(['already-there'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /was previously published .*Skipping placeholder publish/);
    assert.match(result.stdout, /Next steps:/);
    // npm 10 sends the PUT and gets 403; npm 11 checks the packument first and refuses without a PUT.
    assert.ok(publishRequests(registry).length <= 1);
    assert.equal(registry.publishes.length, 0);
  });

  test('fails when the registry rejects the token', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['bad-token'], { NPM_TOKEN: 'wrong-token' });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /E401/);
    assert.match(result.stderr, /Failed to publish placeholder package/);
    assert.equal(publishRequests(registry).length, 1);
    assert.equal(registry.publishes.length, 0);
  });

  test('fails without credentials', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['no-credentials']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ENEEDAUTH|E401/);
    assert.match(result.stderr, /Failed to publish placeholder package/);
    assert.equal(registry.publishes.length, 0);
  });

  test('--dry-run does not contact the registry', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['dry-run-pkg', '--dry-run'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run mode - package created but not published/);
    assert.match(result.stdout, /npm publish --registry /);
    assert.deepEqual(registry.requests, []);
  });

  test('rejects an invalid package name without contacting the registry', async (t) => {
    const { registry, runCli } = await setup(t);
    const result = await runCli(['Invalid_Name'], { NPM_TOKEN: TOKEN });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid package name/);
    assert.deepEqual(registry.requests, []);
  });
});

describe('launched with npx', () => {
  let tarball;
  let packSandbox;
  before(async () => {
    packSandbox = await createSandbox({ registryUrl: 'http://127.0.0.1:9/' });
    tarball = await packCli(packSandbox);
  });
  after(() => packSandbox.cleanup());

  test('selects local packages through the packaged interactive CLI', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx, 'single');
    const npx = npmCommand(['exec', '--yes', `--package=${tarball}`, '--',
      'setup-npm-trusted-publish', '--interactive', '--dry-run', '--registry', ctx.registry]);
    const result = await run(npx.command, npx.args, {
      env: ctx.sandbox.env, cwd: ctx.sandbox.dirs.work, input: interactiveKeys()
    });
    succeeded(result);
    assert.match(result.stdout, /Package: @test\/single/);
    assert.match(result.stdout, /Workflow: release.yml/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('publishes with npm', async (t) => {
    const { registry, sandbox } = await setup(t);
    const npx = npmCommand(['exec', '--yes', `--package=${tarball}`, '--', 'setup-npm-trusted-publish', 'via-npx', '--registry', registry.url]);
    const result = await run(npx.command, npx.args, { env: { ...sandbox.env, NPM_TOKEN: TOKEN }, cwd: sandbox.dirs.work });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(registry.publishes.length, 1);
    assert.equal(registry.publishes[0].name, 'via-npx');
    assert.match(registry.publishes[0].headers['user-agent'], /^npm\//);
  });
});

// The registry assigns capabilities to these dummy credentials; the CLI does
// not infer credential types from their format.
const sessionToken = 'test-login-session';
const granularToken = 'test-granular-token';
const packageName = '@test/oidc-setup';
const githubOptions = ['--github.repo', 'test/repository', '--github.file', 'release.yml'];

async function setupSettings(t) {
  const { registry: registryServer, sandbox } = await setup(t, {
    token: sessionToken, granularToken, settings: true
  });
  const registry = registryServer.url;
  const { state } = registryServer;
  const { userconfig } = sandbox;
  const env = { ...sandbox.env, npm_config_browser: 'false', npm_config_fetch_retries: '0', npm_config_provenance: 'false' };
  const npm = args => {
    const resolved = npmCommand([...args, '--registry', registry]);
    return run(resolved.command, resolved.args, { cwd: sandbox.dirs.work, env });
  };
  const setupPackage = (args = [], extraEnv = {}, options = {}) => run(process.execPath,
    [cliPath, packageName, '--registry', registry, ...args], {
      cwd: sandbox.dirs.work, env: { ...env, ...extraEnv }, ...options
    });
  const login = async () => {
    const result = await npm(['login']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(userconfig, 'utf8'), /_authToken=test-login-session/);
  };
  const runInteractive = (args = [], input = '') => run(process.execPath,
    [cliPath, '--interactive', '--registry', registry, ...args], {
      cwd: sandbox.dirs.work, env, input, timeout: 30000
    });
  return { registry, state, userconfig, npm, setupPackage, login, sandbox, runInteractive };
}

function succeeded(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

// Send real keyboard events after each prompt has rendered. No prompt answers
// are injected into the application or its UI library.
function interactiveKeys({ packageKeys = ' \r', workflowKeys = '\x1b[B\r', environment = '', confirm } = {}) {
  const steps = [
    { waitFor: /(?:◯|\( \))\s+@test\//, keys: packageKeys },
    { waitFor: 'GitHub repository (owner/repo)', keys: '\r' },
    { waitFor: /[❯>]\s+checks\.yml/, keys: workflowKeys },
    { waitFor: 'GitHub Actions environment (leave empty if unused)', keys: `${environment}\r` }
  ];
  if (confirm !== undefined) steps.push({ waitFor: 'Publish a placeholder if needed and apply these settings?', keys: confirm ? 'y' : 'n' });
  return steps;
}

async function createProject(ctx, type = 'npm') {
  const root = ctx.sandbox.dirs.work;
  const manifest = { name: 'workspace-root', private: true };
  if (type === 'npm') manifest.workspaces = ['packages/*'];
  if (type === 'yarn') manifest.workspaces = { packages: ['packages/*'] };
  if (type === 'single') {
    manifest.name = '@test/single';
    manifest.private = false;
    manifest.repository = 'https://github.com/example/project.git';
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  if (type === 'pnpm') await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  if (type === 'lerna') await writeFile(join(root, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }));
  if (type !== 'single') {
    for (const name of ['alpha', 'beta', 'private']) {
      const directory = join(root, 'packages', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@test/${name}`, private: name === 'private' }));
    }
    // This package is not in a workspace and must not be offered.
    await mkdir(join(root, 'fixtures'), { recursive: true });
    await writeFile(join(root, 'fixtures', 'package.json'), JSON.stringify({ name: '@test/fixture' }));
  }
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  for (const file of ['checks.yml', 'release.yml']) {
    await writeFile(join(root, '.github', 'workflows', file), 'name: Test\non: workflow_dispatch\n');
  }
  succeeded(await run('git', ['init', '--quiet'], { cwd: root, env: ctx.sandbox.env }));
  succeeded(await run('git', ['remote', 'add', 'origin', 'git@github.com:example/project.git'], { cwd: root, env: ctx.sandbox.env }));
  return root;
}

describe('package and workflow selection', () => {
  for (const [form, definition] of [
    ['string', 'environment: npm\n'],
    ['object', 'environment:\n      name: npm\n      url: https://example.com\n']
  ]) {
    test(`uses workflow ${form} environment as the editable default`, async t => {
      const ctx = await setupSettings(t);
      const root = await createProject(ctx);
      await writeFile(join(root, '.github', 'workflows', 'release.yml'), `jobs:\n  publish:\n    ${definition}`);
      await ctx.login();
      const result = await ctx.runInteractive([], interactiveKeys({ confirm: true }));
      succeeded(result);
      assert.match(result.stdout, /environment \(leave empty if unused\) \[npm\]/);
      assert.equal(ctx.state.trust[0].claims.environment, 'npm');
    });
  }

  for (const [description, keys, expected] of [
    ['replaces', 'custom', 'custom'],
    ['clears', '\x7f'.repeat(3), '(none)']
  ]) {
    test(`${description} the suggested workflow environment`, async t => {
      const ctx = await setupSettings(t);
      const root = await createProject(ctx);
      await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'jobs:\n  publish:\n    environment: npm\n');
      const result = await ctx.runInteractive(['--dry-run'], interactiveKeys({ environment: keys }));
      succeeded(result);
      assert.ok(result.stdout.includes(`Environment: ${expected}`));
      assert.equal(ctx.state.requests.length, 0);
    });
  }

  test('chooses between multiple workflow environments instead of guessing', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'jobs:\n  first:\n    environment: production\n  second:\n    environment:\n      name: staging\n');
    const keys = interactiveKeys();
    const result = await ctx.runInteractive(['--dry-run'], [
      ...keys.slice(0, 3),
      { waitFor: /❯\s+production/, keys: '\x1b[B\r' },
      keys[3]
    ]);
    succeeded(result);
    assert.match(result.stdout, /Environment: staging/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('does not pass an environment expression to npm trust', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'jobs:\n  publish:\n    environment:\n      name: ${{ matrix.environment }}\n');
    const result = await ctx.runInteractive(['--dry-run'], interactiveKeys({ environment: 'npm' }));
    succeeded(result);
    assert.match(result.stdout, /runtime environment name/);
    assert.match(result.stdout, /Environment: npm/);
    assert.doesNotMatch(result.stdout, /--env \$\{\{/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('explicit environment overrides workflow detection', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'jobs:\n  publish:\n    environment: production\n');
    const result = await ctx.runInteractive(['--github.env', 'custom', '--dry-run'], interactiveKeys().slice(0, 3));
    succeeded(result);
    assert.match(result.stdout, /Environment: custom/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('unreadable workflow settings allow manual environment input', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'jobs: [');
    const result = await ctx.runInteractive(['--dry-run'], interactiveKeys({ environment: 'manual' }));
    succeeded(result);
    assert.match(result.stdout, /Enter the environment manually/);
    assert.match(result.stdout, /Environment: manual/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('keeps checked packages when filtering and configures every selected package', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    await ctx.login();
    const result = await ctx.runInteractive([], [
      { waitFor: /(?:◯|\( \))\s+@test\/alpha/, keys: ' beta' },
      { waitFor: 'Filter: beta', keys: ' \r' },
      ...interactiveKeys({ confirm: true }).slice(1)
    ]);
    succeeded(result);
    assert.match(result.stdout, /Packages: @test\/alpha, @test\/beta/);
    assert.match(result.stdout, /Completed packages: @test\/alpha, @test\/beta/);
    assert.deepEqual([...ctx.state.packages.keys()], ['@test/alpha', '@test/beta']);
    for (const name of ['@test/alpha', '@test/beta']) {
      assert.equal(ctx.state.trustByPackage.get(name)[0].claims.workflow_ref.file, 'release.yml');
      assert.equal(ctx.state.mfaByPackage.get(name).publish_requires_tfa, true);
    }
  });

  test('stops a batch on failure and reports completed and unattempted packages', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    await mkdir(join(root, 'packages', 'gamma'));
    await writeFile(join(root, 'packages', 'gamma', 'package.json'), JSON.stringify({ name: '@test/gamma' }));
    await ctx.login();
    ctx.state.denyMfaPackages.add('@test/beta');
    const result = await ctx.runInteractive([], interactiveKeys({
      packageKeys: ' \x1b[B \x1b[B \r', confirm: true
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Completed packages: @test\/alpha/);
    assert.match(result.stderr, /Failed package: @test\/beta/);
    assert.match(result.stderr, /Not attempted: @test\/gamma/);
    assert.equal(ctx.state.mfaByPackage.get('@test/alpha').publish_requires_tfa, true);
    assert.ok(!ctx.state.mfaByPackage.has('@test/beta'));
    assert.ok(!ctx.state.packages.has('@test/gamma'));
  });

  test('previews all selected packages without contacting the registry', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive(['--dry-run'], interactiveKeys({ packageKeys: ' \x1b[B \r' }));
    succeeded(result);
    assert.match(result.stdout, /Previewed packages: @test\/alpha, @test\/beta/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('filters package paths and workflow names with case-insensitive substring search', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive(['--dry-run'], [
      { waitFor: /(?:◯|\( \))\s+@test\/alpha/, keys: 'PACKAGES/BETA' },
      { waitFor: /(?:◯|\( \))\s+@test\/beta/, keys: ' \r' },
      { waitFor: 'GitHub repository (owner/repo)', keys: '\r' },
      { waitFor: /[❯>]\s+checks\.yml/, keys: 'LEASE' },
      { waitFor: /[❯>]\s+release\.yml/, keys: '\r' },
      { waitFor: 'GitHub Actions environment (leave empty if unused)', keys: '\r' }
    ]);
    succeeded(result);
    assert.match(result.stdout, /Package: @test\/beta/);
    assert.match(result.stdout, /Workflow: release.yml/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('backspace restores choices after a search with no matches', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive(['--dry-run'], [
      { waitFor: /(?:◯|\( \))\s+@test\/alpha/, keys: 'missing' },
      { waitFor: 'No matches for this query.', keys: '\x7f'.repeat(7) + 'beta' },
      { waitFor: /(?:◯|\( \))\s+@test\/beta/, keys: ' \r' },
      ...interactiveKeys().slice(1)
    ]);
    succeeded(result);
    assert.match(result.stdout, /Package: @test\/beta/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('submitting a search with no matches cannot select or publish a package', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive([], [
      { waitFor: /(?:◯|\( \))\s+@test\/alpha/, keys: 'missing' },
      { waitFor: 'No matches for this query.', keys: ' \x1b[C\x1b[D\r' },
      { waitFor: 'Select at least one package.', keys: '\x03' },
      { waitFor: 'Setup cancelled.', keys: '' }
    ]);
    succeeded(result);
    assert.match(result.stdout, /Select at least one package/);
    assert.equal(ctx.state.requests.length, 0);
  });

  for (const [name, key] of [['Escape', '\x1b'], ['Ctrl+C', '\x03']]) {
    test(`${name} cancels selection without registry access`, async t => {
      const ctx = await setupSettings(t);
      await createProject(ctx);
      const result = await ctx.runInteractive([], [
        { waitFor: /(?:◯|\( \))\s+@test\/alpha/, keys: key },
        { waitFor: 'Setup cancelled.', keys: '' }
      ]);
      succeeded(result);
      assert.equal(ctx.state.requests.length, 0);
    });
  }

  test('uses root repository metadata when a workspace only declares repository.directory', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    succeeded(await run('git', ['remote', 'remove', 'origin'], { cwd: root, env: ctx.sandbox.env }));
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    manifest.repository = { url: 'https://github.com/example/project.git' };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'packages', 'alpha', 'package.json'), JSON.stringify({
      name: '@test/alpha', repository: { directory: 'packages/alpha' }
    }));
    const result = await ctx.runInteractive(['--dry-run'], interactiveKeys());
    succeeded(result);
    assert.match(result.stdout, /GitHub repository \(owner\/repo\).*example\/project/);
    assert.match(result.stdout, /MFA: publish \(require 2FA; disallow access tokens; allow trusted publishing\)/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('selects workspace package and workflow before publishing and configuring settings', async t => {
    const ctx = await setupSettings(t);
    const root = await createProject(ctx);
    const originalManifest = await readFile(join(root, 'package.json'), 'utf8');
    await ctx.login();
    const result = await ctx.runInteractive([], interactiveKeys({ packageKeys: '\x1b[B \r', environment: 'production', confirm: true }));
    succeeded(result);
    assert.match(result.stdout, /@test\/alpha \(packages\/alpha\/package.json\)/);
    assert.doesNotMatch(result.stdout, /@test\/(private|fixture)/);
    assert.equal(ctx.state.packages.get('@test/beta').name, '@test/beta');
    assert.deepEqual(ctx.state.trust[0].claims, {
      repository: 'example/project', workflow_ref: { file: 'release.yml' }, environment: 'production'
    });
    assert.deepEqual(ctx.state.mfa, { publish_requires_tfa: true, automation_token_overrides_tfa: false });
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), originalManifest);
  });

  for (const type of ['yarn', 'pnpm', 'lerna', 'single']) {
    test(`discovers ${type} packages without registry access in dry-run`, async t => {
      const ctx = await setupSettings(t);
      await createProject(ctx, type);
      const result = await ctx.runInteractive(['--dry-run'], interactiveKeys());
      succeeded(result);
      assert.match(result.stdout, new RegExp(`Package: @test/${type === 'single' ? 'single' : 'alpha'}`));
      assert.match(result.stdout, /Workflow: release.yml/);
      assert.doesNotMatch(result.stdout, /@test\/(private|fixture)/);
      assert.equal(ctx.state.requests.length, 0);
    });
  }

  test('cancellation and closed input stop before any registry requests', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const cancelled = await ctx.runInteractive([], interactiveKeys({ confirm: false }));
    succeeded(cancelled);
    assert.match(cancelled.stdout, /Setup cancelled/);
    const closed = await ctx.runInteractive([], '');
    assert.equal(closed.code, 1);
    assert.match(closed.stderr, /Input closed/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('explicit package and flags remain usable in interactive preview', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive([
      '@test/beta', '--github.repo', 'other/repository', '--github.file', 'release.yml',
      '--github.env', 'npm', '--mfa', 'automation', '--dry-run'
    ]);
    succeeded(result);
    assert.match(result.stdout, /Package: @test\/beta/);
    assert.match(result.stdout, /Repository: other\/repository/);
    assert.match(result.stdout, /MFA: automation/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('reports missing publishable packages without scanning unrelated directories', async t => {
    const ctx = await setupSettings(t);
    await writeFile(join(ctx.sandbox.dirs.work, 'package.json'), JSON.stringify({ name: 'private-root', private: true }));
    const result = await ctx.runInteractive(['--dry-run']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No publishable packages found/);
    assert.equal(ctx.state.requests.length, 0);
  });
});

describe('temporary npm authentication', () => {
  test('shares one temporary login session across selected packages', async t => {
    const ctx = await setupSettings(t);
    await createProject(ctx);
    const result = await ctx.runInteractive(['--ephemeral-auth'], interactiveKeys({
      packageKeys: ' \x1b[B \r', confirm: true
    }));
    succeeded(result);
    assert.deepEqual([...ctx.state.packages.keys()], ['@test/alpha', '@test/beta']);
    assert.equal(ctx.state.trustByPackage.size, 2);
    assert.equal(ctx.state.mfaByPackage.size, 2);
    assert.equal(ctx.state.requests.filter(req => req.method === 'POST' && req.path === '/-/v1/login').length, 1);
    assert.equal(ctx.state.requests.filter(req => req.method === 'DELETE').length, 1);
    assert.equal(ctx.state.sessions.size, 0);
    assert.ok(result.stdout.indexOf('apply these settings?') < result.stdout.indexOf('Logging in with a temporary'));
  });

  test('logs out and removes temporary credentials while preserving existing user and project authentication', async t => {
    const ctx = await setupSettings(t);
    const registryHost = new URL(ctx.registry).host;
    const original = `//${registryHost}/:_authToken=existing-session\n`;
    await writeFile(ctx.userconfig, original);
    ctx.state.sessions.add('existing-session');
    const projectConfig = `//${registryHost}/:_authToken=${granularToken}\n`;
    await writeFile(join(ctx.sandbox.dirs.work, '.npmrc'), projectConfig);
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish', '--ephemeral-auth'], { NPM_TOKEN: granularToken });
    succeeded(result);
    assert.equal(ctx.state.mfa.publish_requires_tfa, true);
    assert.equal(ctx.state.sessions.has('existing-session'), true);
    assert.equal(ctx.state.sessions.has(sessionToken), false);
    assert.equal(await readFile(ctx.userconfig, 'utf8'), original);
    assert.equal(await readFile(join(ctx.sandbox.dirs.work, '.npmrc'), 'utf8'), projectConfig);
    assert.deepEqual((await readdir(ctx.sandbox.dirs.tmp)).filter(name => name.startsWith('npm-setup-session-')), []);
    assert.equal(ctx.state.requests.filter(req => req.method === 'DELETE').length, 1);
    assert.doesNotMatch(result.stdout, /When finished: npm logout/);
  });

  test('logs out after package setup fails', async t => {
    const ctx = await setupSettings(t);
    ctx.state.denyTrust = true;
    const result = await ctx.setupPackage([...githubOptions, '--ephemeral-auth']);
    assert.equal(result.code, 1);
    assert.equal(ctx.state.sessions.size, 0);
    assert.equal(ctx.state.requests.filter(req => req.method === 'DELETE').length, 1);
    assert.deepEqual((await readdir(ctx.sandbox.dirs.tmp)).filter(name => name.startsWith('npm-setup-session-')), []);
  });

  test('retries failed logout, reports failure, and retains protected credentials for recovery', async t => {
    const ctx = await setupSettings(t);
    ctx.state.denyLogout = true;
    const result = await ctx.setupPackage([...githubOptions, '--ephemeral-auth']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Completed packages:/);
    assert.match(result.stderr, /Temporary session logout failed/);
    assert.equal(ctx.state.requests.filter(req => req.method === 'DELETE').length, 3);
    const authFile = result.stderr.match(/Authentication file retained for retry: (.+)/)[1];
    assert.ok(authFile.startsWith(ctx.sandbox.dirs.tmp));
    if (process.platform !== 'win32') assert.equal((await stat(authFile)).mode & 0o777, 0o600);
    ctx.state.denyLogout = false;
    succeeded(await ctx.npm(['logout', '--userconfig', authFile]));
    assert.equal(ctx.state.sessions.size, 0);
  });

  test('dry-run and cancelled confirmation do not log in', async t => {
    const ctx = await setupSettings(t);
    succeeded(await ctx.setupPackage([...githubOptions, '--ephemeral-auth', '--dry-run']));
    await createProject(ctx);
    const cancelled = await ctx.runInteractive(['--ephemeral-auth'], interactiveKeys({ confirm: false }));
    succeeded(cancelled);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('Ctrl+C runs logout before exiting', { skip: process.platform === 'win32' ? 'Windows process.kill does not deliver console Ctrl+C' : false }, async t => {
    const ctx = await setupSettings(t);
    const result = await ctx.setupPackage([...githubOptions, '--ephemeral-auth'], {}, { signalOnOutput: '1/1:' });
    assert.equal(result.code, 130);
    assert.equal(ctx.state.sessions.size, 0);
    assert.equal(ctx.state.requests.filter(req => req.method === 'DELETE').length, 1);
    assert.deepEqual((await readdir(ctx.sandbox.dirs.tmp)).filter(name => name.startsWith('npm-setup-session-')), []);
  });
});

describe('trusted publishing and MFA via npm login', () => {
  test('waits for registry visibility before configuring trust and MFA', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.visibilityDelayReads = 2;
    succeeded(await ctx.setupPackage([...githubOptions, '--mfa', 'publish', '--wait-timeout', '15']));
    const publishIndex = ctx.state.requests.findIndex(req => req.method === 'PUT');
    const trustIndex = ctx.state.requests.findIndex(req => req.method === 'POST' && req.path.endsWith('/trust'));
    const reads = ctx.state.requests.slice(publishIndex + 1, trustIndex).filter(req => req.method === 'GET');
    assert.deepEqual(reads.map(req => req.status), [404, 404, 200]);
    assert.equal(ctx.state.requests.filter(req => req.method === 'PUT').length, 1);
    assert.equal(ctx.state.trust.length, 1);
    assert.equal(ctx.state.mfa.publish_requires_tfa, true);
  });

  test('visibility timeout preserves the publish and does not change settings', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.visibilityDelayReads = 100;
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish', '--wait-timeout', '1']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Timed out after 1s waiting/);
    assert.match(result.stderr, /Last completed step: Placeholder publish step completed/);
    assert.equal(ctx.state.requests.filter(req => req.method === 'PUT').length, 1);
    assert.ok(!ctx.state.requests.some(req => req.path.endsWith('/trust') || req.path.endsWith('/access')));
    assert.equal(ctx.state.trust.length, 0);
    assert.equal(ctx.state.mfa, null);
  });

  test('real npm login → placeholder publish → trust → MFA → logout', { timeout: 60000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    const result = await ctx.setupPackage([...githubOptions, '--github.env', 'npm publish', '--mfa', 'publish']);
    succeeded(result);
    const pkg = ctx.state.packages.get(packageName);
    assert.equal(pkg.name, packageName);
    assert.equal(pkg['dist-tags'].latest, '0.0.0');
    assert.ok(pkg._attachments[Object.keys(pkg._attachments)[0]].data.length > 0);
    assert.deepEqual(ctx.state.trust[0], {
      id: 'test-trust-id', type: 'github',
      claims: { repository: 'test/repository', workflow_ref: { file: 'release.yml' }, environment: 'npm publish' },
      permissions: ['createPackage']
    });
    assert.deepEqual(ctx.state.mfa, { publish_requires_tfa: true, automation_token_overrides_tfa: false });
    const writes = ctx.state.requests.filter(req => req.method === 'PUT' || req.path.endsWith('/trust') || req.path.endsWith('/access'));
    assert.deepEqual(writes.map(req => req.method), ['PUT', 'POST', 'POST']);
    assert.ok(writes.every(req => req.auth === 'session'));
    const tempPath = result.stdout.match(/Temp directory: (.+)/)[1];
    await assert.rejects(readFile(join(tempPath, 'package.json')), { code: 'ENOENT' });
    succeeded(await ctx.npm(['trust', 'list', packageName]));
    succeeded(await ctx.npm(['logout']));
    assert.equal(ctx.state.sessions.has(sessionToken), false);
    const remainingConfig = await readFile(ctx.userconfig, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.doesNotMatch(remainingConfig, /_authToken/);
    assert.match(result.stdout, /When finished: npm logout/);
  });

  test('existing package receives MFA without republishing', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.packages.set(packageName, { name: packageName });
    succeeded(await ctx.setupPackage(['--mfa', 'automation']));
    assert.ok(!ctx.state.requests.some(req => req.method === 'PUT'));
    assert.deepEqual(ctx.state.mfa, { publish_requires_tfa: true, automation_token_overrides_tfa: true });
  });

  test('NPM_TOKEN publishes only a placeholder without logging the token', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    const result = await ctx.setupPackage([], { NPM_TOKEN: granularToken });
    succeeded(result);
    assert.equal(ctx.state.requests.find(req => req.method === 'PUT').auth, 'granular');
    assert.equal(ctx.state.trust.length, 0);
    assert.equal(ctx.state.mfa, null);
    assert.doesNotMatch(result.stdout + result.stderr, /test-granular-token/);
  });

  test('NPM_TOKEN with settings fails before publishing and explains how to login', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish'], { NPM_TOKEN: granularToken });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unset NPM_TOKEN and run npm login/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('whoami accepts a granular token in npmrc, but changing trust fails with login guidance', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    const host = new URL(ctx.registry).host;
    await writeFile(ctx.userconfig, `//${host}/:_authToken=${granularToken}\n`);
    ctx.state.packages.set(packageName, { name: packageName });
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /npm login/);
    assert.equal(ctx.state.trust.length, 0);
    assert.equal(ctx.state.mfa, null);
    assert.ok(ctx.state.requests.some(req => req.path === '/-/whoami' && req.auth === 'granular'));
  });

  test('dry-run previews all settings without authenticating or contacting the registry', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish', '--dry-run'], { NPM_TOKEN: granularToken });
    succeeded(result);
    assert.match(result.stdout, /npm trust github/);
    assert.match(result.stdout, /--allow-publish/);
    assert.match(result.stdout, /npm access set mfa=publish/);
    assert.equal(ctx.state.requests.length, 0);
  });

  test('metadata failures stop setup rather than publishing a new package', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.metadataError = 503;
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not check whether the package exists/);
    assert.equal(ctx.state.packages.size, 0);
    assert.equal(ctx.state.trust.length, 0);
  });

  test('MFA failure reports completed trust and can be retried with MFA only', { timeout: 60000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.denyMfa = true;
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last completed step: Trusted Publisher configured/);
    assert.match(result.stderr, /npm logout/);
    assert.equal(ctx.state.packages.size, 1);
    assert.equal(ctx.state.trust.length, 1);
    assert.equal(ctx.state.mfa, null);
    ctx.state.denyMfa = false;
    succeeded(await ctx.setupPackage(['--mfa', 'publish']));
    assert.equal(ctx.state.requests.filter(req => req.method === 'PUT').length, 1);
    assert.equal(ctx.state.requests.filter(req => req.method === 'POST' && req.path.endsWith('/trust')).length, 1);
    assert.equal(ctx.state.mfa.publish_requires_tfa, true);
  });

  test('invalid options fail without registry requests', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    for (const args of [
      ['--mfa', 'invalid'], ['--github.env', 'npm'],
      ['--wait-timeout', '0'], ['--wait-timeout', 'invalid'],
      ['--github.repo', 'invalid', '--github.file', 'release.yml'],
      ['--github.repo', 'test/repository', '--github.file', '.github/workflows/release.yml']
    ]) {
      assert.equal((await ctx.setupPackage(args)).code, 1);
    }
    assert.equal(ctx.state.requests.length, 0);
  });

  test('publish failure stops trust and MFA and cleans up temporary files', { timeout: 30000 }, async t => {
    const ctx = await setupSettings(t);
    await ctx.login();
    ctx.state.denyPublish = true;
    const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
    assert.equal(result.code, 1);
    assert.equal(ctx.state.trust.length, 0);
    assert.equal(ctx.state.mfa, null);
    const tempPath = result.stdout.match(/Temp directory: (.+)/)[1];
    await assert.rejects(readFile(join(tempPath, 'package.json')), { code: 'ENOENT' });
  });
});
