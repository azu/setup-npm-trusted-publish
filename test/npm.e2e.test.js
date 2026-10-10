// E2E tests that run the CLI with the real npm CLI against a local fake registry.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
    assert.equal(publishRequests(registry).length, 1);
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
