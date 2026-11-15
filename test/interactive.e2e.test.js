// Real npm CLI requests against the local registry; browser 2FA is not simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeRegistry } from './helpers/fake-registry.js';
import { createSandbox, run, cliPath, npmCommand } from './helpers/sandbox.js';

// The registry assigns capabilities to these dummy credentials; the CLI does
// not infer credential types from their format.
const sessionToken = 'test-login-session';
const granularToken = 'test-granular-token';
const packageName = '@test/oidc-setup';
const githubOptions = ['--github.repo', 'test/repository', '--github.file', 'release.yml'];

async function setup(t) {
  const registryServer = await startFakeRegistry({ token: sessionToken, granularToken, interactive: true });
  const registry = registryServer.url;
  const { state } = registryServer;
  const sandbox = await createSandbox({ registryUrl: registry });
  t.after(async () => {
    await registryServer.close();
    await sandbox.cleanup();
  });
  const { userconfig } = sandbox;
  const env = { ...sandbox.env, npm_config_browser: 'false', npm_config_fetch_retries: '0', npm_config_provenance: 'false' };
  const npm = args => {
    const resolved = npmCommand([...args, '--registry', registry]);
    return run(resolved.command, resolved.args, { cwd: sandbox.dirs.work, env });
  };
  const setupPackage = (args = [], extraEnv = {}) => run(process.execPath,
    [cliPath, packageName, '--registry', registry, ...args], {
      cwd: sandbox.dirs.work, env: { ...env, ...extraEnv }
    });
  const login = async () => {
    const result = await npm(['login']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(userconfig, 'utf8'), /_authToken=test-login-session/);
  };
  return { registry, state, userconfig, npm, setupPackage, login };
}

function succeeded(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

test('real npm login → placeholder publish → trust → MFA → logout', { timeout: 60000 }, async t => {
  const ctx = await setup(t);
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
  const ctx = await setup(t);
  await ctx.login();
  ctx.state.packages.set(packageName, { name: packageName });
  succeeded(await ctx.setupPackage(['--mfa', 'automation']));
  assert.ok(!ctx.state.requests.some(req => req.method === 'PUT'));
  assert.deepEqual(ctx.state.mfa, { publish_requires_tfa: true, automation_token_overrides_tfa: true });
});

test('NPM_TOKEN publishes only a placeholder without logging the token', { timeout: 30000 }, async t => {
  const ctx = await setup(t);
  const result = await ctx.setupPackage([], { NPM_TOKEN: granularToken });
  succeeded(result);
  assert.equal(ctx.state.requests.find(req => req.method === 'PUT').auth, 'granular');
  assert.equal(ctx.state.trust.length, 0);
  assert.equal(ctx.state.mfa, null);
  assert.doesNotMatch(result.stdout + result.stderr, /test-granular-token/);
});

test('NPM_TOKEN with settings fails before publishing and explains how to login', { timeout: 30000 }, async t => {
  const ctx = await setup(t);
  const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish'], { NPM_TOKEN: granularToken });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unset NPM_TOKEN and run npm login/);
  assert.equal(ctx.state.requests.length, 0);
});

test('whoami accepts a granular token in npmrc, but changing trust fails with login guidance', { timeout: 30000 }, async t => {
  const ctx = await setup(t);
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
  const ctx = await setup(t);
  const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish', '--dry-run'], { NPM_TOKEN: granularToken });
  succeeded(result);
  assert.match(result.stdout, /npm trust github/);
  assert.match(result.stdout, /--allow-publish/);
  assert.match(result.stdout, /npm access set mfa=publish/);
  assert.equal(ctx.state.requests.length, 0);
});

test('metadata failures stop setup rather than publishing a new package', { timeout: 30000 }, async t => {
  const ctx = await setup(t);
  await ctx.login();
  ctx.state.metadataError = 503;
  const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not check whether the package exists/);
  assert.equal(ctx.state.packages.size, 0);
  assert.equal(ctx.state.trust.length, 0);
});

test('MFA failure reports completed trust and can be retried with MFA only', { timeout: 60000 }, async t => {
  const ctx = await setup(t);
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
  const ctx = await setup(t);
  for (const args of [
    ['--mfa', 'invalid'], ['--github.env', 'npm'],
    ['--github.repo', 'invalid', '--github.file', 'release.yml'],
    ['--github.repo', 'test/repository', '--github.file', '.github/workflows/release.yml']
  ]) {
    assert.equal((await ctx.setupPackage(args)).code, 1);
  }
  assert.equal(ctx.state.requests.length, 0);
});

test('publish failure stops trust and MFA and cleans up temporary files', { timeout: 30000 }, async t => {
  const ctx = await setup(t);
  await ctx.login();
  ctx.state.denyPublish = true;
  const result = await ctx.setupPackage([...githubOptions, '--mfa', 'publish']);
  assert.equal(result.code, 1);
  assert.equal(ctx.state.trust.length, 0);
  assert.equal(ctx.state.mfa, null);
  const tempPath = result.stdout.match(/Temp directory: (.+)/)[1];
  await assert.rejects(readFile(join(tempPath, 'package.json')), { code: 'ENOENT' });
});
