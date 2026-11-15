#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { values, positionals } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      short: 'h',
      default: false
    },
    version: {
      type: 'boolean',
      short: 'v',
      default: false
    },
    'dry-run': {
      type: 'boolean',
      default: false
    },
    access: {
      type: 'string',
      default: 'public'
    },
    registry: {
      type: 'string',
      default: 'https://registry.npmjs.org'
    },
    'package-version': {
      type: 'string',
      default: '0.0.0'
    },
    mfa: { type: 'string' },
    interactive: { type: 'boolean', short: 'i', default: false },
    'ephemeral-auth': { type: 'boolean', default: false },
    'github.repo': { type: 'string' },
    'github.file': { type: 'string' },
    'github.env': { type: 'string' },
    'wait-timeout': { type: 'string', default: '300' }
  },
  allowPositionals: true
});

if (values.help) {
  console.log(`
Usage: setup-npm-trusted-publish <package-name> [options]

Publishes a minimal placeholder package to npm so you can configure OIDC
trusted publishing on npmjs.com afterwards.
With --github.* or --mfa, also configures package settings interactively.
Run npm login first or use --ephemeral-auth; npm trust requires account-level 2FA.

Arguments:
  <package-name>  The name of the npm package to setup (e.g. my-package, @scope/my-package)

Options:
  -h, --help               Show help
  -v, --version            Show version
  --dry-run                Preview actions without making changes
  --access                 Access level for scoped packages (public/restricted) [default: public]
  --registry               npm registry URL [default: https://registry.npmjs.org]
  --package-version        Version to use for the placeholder package [default: 0.0.0]
  --mfa                    Set MFA requirement (none/automation/publish)
                           publish: require 2FA and disallow tokens; OIDC remains allowed
                           automation: require 2FA or a token with bypass 2FA
  -i, --interactive        Select local packages and a GitHub workflow, then confirm setup
  --ephemeral-auth         Use a temporary npm login session; always attempt logout on exit
  --github.repo            GitHub repository allowed to publish (owner/repo)
  --github.file            Workflow filename in .github/workflows (e.g. release.yml)
  --github.env             Required GitHub Actions environment (optional)
  --wait-timeout           Seconds to wait for a published package before settings [default: 300]

GitHub configuration requires npm >= 11.15.0 and grants npm publish permission.

Examples:
  setup-npm-trusted-publish --interactive --ephemeral-auth
  unset NPM_TOKEN
  npm login --registry https://registry.npmjs.org
  setup-npm-trusted-publish @scope/my-package \\
    --github.repo owner/repo --github.file release.yml --mfa publish
  npm logout --registry https://registry.npmjs.org

  setup-npm-trusted-publish my-package
  setup-npm-trusted-publish @scope/my-package
  read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
  setup-npm-trusted-publish my-package --dry-run
  setup-npm-trusted-publish my-package --registry https://npm.example.com
  setup-npm-trusted-publish my-package --package-version 0.0.1

Without --github.* / --mfa, configure package settings at:
  https://www.npmjs.com/package/<package-name>/access

Package manager:
  Publishes with the package manager that launched this CLI.
  pnpm dlx / pnpx: pnpm publish (uses the credentials saved by pnpm login)
  npx, a global install or anything else: npm publish

Environment:
  NPM_TOKEN   npm auth token for placeholder publish.
              npm: creates a temporary .npmrc for authentication.
              pnpm: passed to pnpm through its environment only.
              Unset it and use npm login for --github.* / --mfa.
`);
  process.exit(0);
}

if (values.version) {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  console.log(pkg.default.version);
  process.exit(0);
}

const validPackageNameRegex = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
let packageName = positionals[0];

async function runPackages(names, context = {}) {
  const completed = [];
  for (const [index, name] of names.entries()) {
    console.log(`\n📦 ${index + 1}/${names.length}: ${name}`);
    const args = [fileURLToPath(import.meta.url), name];
    for (const key of ['registry', 'access', 'package-version', 'github.repo', 'github.file', 'github.env', 'mfa', 'wait-timeout']) {
      if (values[key] !== undefined) args.push(`--${key}`, values[key]);
    }
    if (values['dry-run']) args.push('--dry-run');
    const code = context.run ? await context.run(process.execPath, args) : await new Promise(resolve => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.on('error', error => { console.error(error.message); resolve(1); });
      child.on('close', code => resolve(code ?? 1));
    });
    if (code !== 0) {
      console.error(`Completed packages: ${completed.join(', ') || '(none)'}`);
      console.error(`Failed package: ${name}. See above for any completed steps within this package.`);
      console.error(`Not attempted: ${names.slice(index + 1).join(', ') || '(none)'}`);
      return code;
    }
    completed.push(name);
  }
  console.log(`\n${values['dry-run'] ? 'Previewed' : 'Completed'} packages: ${completed.join(', ')}`);
  return 0;
}

async function dispatchPackages(names) {
  assertNpmTrustVersion();
  if (values['ephemeral-auth'] && !values['dry-run']) {
    const { withEphemeralAuth } = await import('./session.js');
    return withEphemeralAuth({ registry: values.registry, npmCommand: resolveNpmCommand }, context => runPackages(names, context));
  }
  return runPackages(names);
}

if (values.interactive) {
  if (process.env.NPM_TOKEN && !values['dry-run'] && !values['ephemeral-auth']) {
    console.error(`Error: Unset NPM_TOKEN and run npm login --registry ${values.registry} before interactive setup.`);
    process.exit(1);
  }
  try {
    const { interactiveSetup } = await import('./interactive.js');
    const selection = await interactiveSetup({ packageName, values });
    if (!selection) process.exit(0);
    Object.assign(values, selection.values);
    if (selection.packageNames.some(name => !validPackageNameRegex.test(name))) {
      throw new Error('Selected packages contain an invalid npm package name.');
    }
    if (selection.packageNames.length > 1 || values['ephemeral-auth']) {
      process.exit(await dispatchPackages(selection.packageNames));
    }
    packageName = selection.packageNames[0];
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (!packageName) {
  console.error('Error: Package name is required');
  console.error('Usage: setup-npm-trusted-publish <package-name>');
  process.exit(1);
}

// Validate package name
if (!validPackageNameRegex.test(packageName)) {
  console.error(`Error: Invalid package name: ${packageName}`);
  console.error('Package names must be lowercase and can contain letters, numbers, hyphens, periods, and underscores');
  process.exit(1);
}

if (values['ephemeral-auth']) {
  try { process.exit(await dispatchPackages([packageName])); }
  catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

// npm is `npm.cmd` on Windows, which execFile cannot start (Node refuses to spawn a .cmd file without a shell).
// Run npm's own entry script with this Node instead: no shell is involved, so no argument needs quoting.
// Elsewhere, or when the script cannot be found (for example npm is a standalone npm.exe shim), run `npm` as before.
function resolveNpmCommand(args) {
  if (process.platform === 'win32') {
    const npmCli = [
      process.env.npm_execpath,
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ].find((candidate) => candidate && basename(candidate) === 'npm-cli.js' && existsSync(candidate));
    if (npmCli) {
      return { command: process.execPath, args: [npmCli, ...args] };
    }
  }
  return { command: 'npm', args };
}

function runNpm(args, options) {
  const resolved = resolveNpmCommand(args);
  return execFileSync(resolved.command, resolved.args, options);
}

// Check local prerequisites before creating a temporary login session. Keep
// this shared by batch dispatch and the ordinary single-package flow.
function assertNpmTrustVersion() {
  if (values['dry-run'] || !Object.keys(values).some(key => key.startsWith('github.'))) return;
  let version;
  try {
    version = runNpm(['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  } catch {
    throw new Error('Could not check npm version. Ensure npm >= 11.15.0 is installed and available on PATH.');
  }
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 11 || (major === 11 && minor >= 15))) {
    throw new Error(`GitHub configuration requires npm >= 11.15.0 (current: ${version}). Update npm with npm install -g npm@^11.15.0 and retry.`);
  }
}

// Follow the package manager that launched this CLI. `pnpm dlx` and `pnpx` set npm_config_user_agent to `pnpm/<version> ...`.
// npx, a global install, other package managers, or a missing user agent keep using npm.
// npm_execpath is not used to decide: pnpm 10 does not set it for `pnpm dlx`.
function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? '') {
  return userAgent.startsWith('pnpm/') ? 'pnpm' : 'npm';
}

// Run the pnpm that launched this CLI when npm_execpath points to it (pnpm 11+), otherwise `pnpm` from PATH.
// Like npm, pnpm installed with npm is `pnpm.cmd` on Windows, so run its entry script with this Node instead.
function resolvePnpmCommand(args) {
  const pnpmPath = process.env.npm_execpath;
  if (pnpmPath && /^pnpm(\.(?:c?js|mjs|exe))?$/i.test(basename(pnpmPath)) && existsSync(pnpmPath)) {
    if (/\.(?:c?js|mjs)$/i.test(pnpmPath)) {
      return { command: process.execPath, args: [pnpmPath, ...args] };
    }
    if (process.platform !== 'win32' || /\.exe$/i.test(pnpmPath)) {
      return { command: pnpmPath, args };
    }
  }
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || !existsSync(join(dir, 'pnpm.cmd'))) continue;
      const pnpmCli = ['pnpm.cjs', 'pnpm.mjs']
        .map((file) => join(dir, 'node_modules', 'pnpm', 'bin', file))
        .find((candidate) => existsSync(candidate));
      if (pnpmCli) {
        return { command: process.execPath, args: [pnpmCli, ...args] };
      }
    }
  }
  return { command: 'pnpm', args };
}

const configureGitHub = Object.keys(values).some(key => key.startsWith('github.'));
const configureSettings = configureGitHub || values.mfa !== undefined;
const waitTimeoutSeconds = Number(values['wait-timeout']);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (values.mfa !== undefined && !['none', 'publish', 'automation'].includes(values.mfa)) {
  fail('--mfa must be one of: none, publish, automation');
}
if (!Number.isFinite(waitTimeoutSeconds) || waitTimeoutSeconds <= 0) {
  fail('--wait-timeout must be a positive number of seconds');
}
if (configureGitHub) {
  if (!values['github.repo'] || !values['github.file']) {
    fail('--github.repo and --github.file are required for GitHub Actions');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(values['github.repo'])) {
    fail('--github.repo must be in owner/repo format');
  }
  if (!/^[^/\\]+\.ya?ml$/.test(values['github.file'])) {
    fail('--github.file must be a workflow filename ending in .yml or .yaml, without a path');
  }
}
if (configureSettings && process.env.NPM_TOKEN && !values['dry-run']) {
  fail('NPM_TOKEN overrides local login for publishing. Unset NPM_TOKEN and run npm login --registry ' + values.registry + ' before configuring package settings.');
}

const trustArgs = ['trust', 'github', packageName,
  '--repo', values['github.repo'], '--file', values['github.file'], '--allow-publish', '--yes'];
if (values['github.env']) {
  trustArgs.push('--env', values['github.env']);
}
const mfaArgs = ['access', 'set', `mfa=${values.mfa}`, packageName];
for (const args of [trustArgs, mfaArgs]) {
  args.push('--registry', values.registry);
}

// Never probe or mutate the registry while previewing interactive setup.
if (configureSettings && values['dry-run']) {
  console.log(`Dry run: publish a placeholder for ${packageName} only if it does not exist.`);
  console.log(`Registry: ${values.registry}`);
  if (configureGitHub) console.log(`Then run: npm ${trustArgs.join(' ')}`);
  if (values.mfa !== undefined) console.log(`Then run: npm ${mfaArgs.join(' ')}`);
  console.log('Use npm login before setup, complete the 2FA prompts, then npm logout.');
  process.exit(0);
}

function packageExists({ timeout } = {}) {
  try {
    runNpm(['view', packageName, 'name', '--json', '--prefer-online', '--registry', values.registry], { stdio: 'pipe', timeout });
    return true;
  } catch (error) {
    // Auth and connection failures must not be mistaken for a new package.
    try {
      if (JSON.parse(error.stdout?.toString()).error?.code === 'E404') return false;
    } catch {}
    throw new Error('Could not check whether the package exists. Check authentication and registry connectivity.', { cause: error });
  }
}

async function waitForPackage() {
  console.log(`\n⏳ Waiting for ${packageName} to become available on the registry...`);
  console.log(`No input needed. Retrying automatically every 10s for up to ${waitTimeoutSeconds}s; setup continues when the package is available. Ctrl+C to cancel.`);
  const started = Date.now();
  const deadline = started + waitTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (packageExists({ timeout: Math.max(1, deadline - Date.now()) })) {
        console.log('Package is available. Continuing trusted publishing setup...');
        return;
      }
    } catch (error) {
      if (error.cause?.code === 'ETIMEDOUT') break;
      throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      const retryMs = Math.min(10000, remaining);
      console.log(`Still waiting (${Math.floor((Date.now() - started) / 1000)}s elapsed / ${waitTimeoutSeconds}s limit). Retrying automatically in ${Math.ceil(retryMs / 1000)}s...`);
      await delay(retryMs);
    }
  }
  throw new Error(`Timed out after ${waitTimeoutSeconds}s waiting for ${packageName} to become available. The publish step completed; retry setup later without republishing the package.`);
}

if (configureSettings) {
  try { assertNpmTrustVersion(); }
  catch (error) { fail(error.message); }
  try {
    // This verifies authentication, not the token's type or permissions.
    runNpm(['whoami', '--registry', values.registry], { stdio: ['inherit', 'ignore', 'inherit'] });
  } catch {
    fail(`Authentication check failed. Run npm login --registry ${values.registry} and retry.`);
  }
}

// Publish a placeholder package to reserve the name
async function publishPlaceholder(pkgName, opts) {
  const tempDirName = `npm-oidc-setup-${randomBytes(8).toString('hex')}`;
  const pkgDir = join(tmpdir(), tempDirName);
  await mkdir(pkgDir, { recursive: true });

  console.log(`📦 Creating placeholder package: ${pkgName}`);
  console.log(`📁 Temp directory: ${pkgDir}`);

  try {
    const packageJson = {
      name: pkgName,
      version: opts.packageVersion,
      description: `OIDC trusted publishing setup package for ${pkgName}`,
      keywords: ['oidc', 'trusted-publishing', 'setup']
    };

    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n'
    );

    const readmeContent = `# ${pkgName}

## ⚠️ IMPORTANT NOTICE ⚠️

**This package is created solely for the purpose of setting up OIDC (OpenID Connect) trusted publishing with npm.**

This is **NOT** a functional package and contains **NO** code or functionality beyond the OIDC setup configuration.

## Purpose

This package exists to:
1. Configure OIDC trusted publishing for the package name \`${pkgName}\`
2. Enable secure, token-less publishing from CI/CD workflows
3. Establish provenance for packages published under this name

## What is OIDC Trusted Publishing?

OIDC trusted publishing allows package maintainers to publish packages directly from their CI/CD workflows without needing to manage npm access tokens. Instead, it uses OpenID Connect to establish trust between the CI/CD provider (like GitHub Actions) and npm.

## Setup Instructions

To properly configure OIDC trusted publishing for this package:

1. Go to [npmjs.com](https://www.npmjs.com/) and navigate to your package settings
2. Configure the trusted publisher (e.g., GitHub Actions)
3. Specify the repository and workflow that should be allowed to publish
4. Use the configured workflow to publish your actual package

## DO NOT USE THIS PACKAGE

This package is a placeholder for OIDC configuration only. It:
- Contains no executable code
- Provides no functionality
- Should not be installed as a dependency
- Exists only for administrative purposes

## More Information

For more details about npm's trusted publishing feature, see:
- [npm Trusted Publishing Documentation](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Actions OIDC Documentation](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

---

**Maintained for OIDC setup purposes only**
`;

    await writeFile(join(pkgDir, 'README.md'), readmeContent);

    const { packageManager } = opts;
    const npmToken = process.env.NPM_TOKEN;
    const publishEnv = { ...process.env };
    if (npmToken) {
      const registryUrl = new URL(opts.registry);
      // Write only a `${NPM_TOKEN}` reference, never the token itself. npm reads it via --userconfig.
      // pnpm 11+ ignores `${...}` in a project .npmrc and has no --userconfig, but reads it through
      // npm_config_userconfig; pnpm 10 (which publishes through npm) reads it as the project .npmrc.
      // Do not pass the token as `pnpm_config_//<host>/:_authToken` env vars: that name is not a valid
      // shell identifier, so dash drops it when pnpm is started through a `#!/bin/sh` shim
      // (pnpm self-update / pnpm/action-setup), and publishing fails with 401.
      const npmrcPath = join(pkgDir, '.npmrc');
      await writeFile(
        npmrcPath,
        `registry=${opts.registry}\n//${registryUrl.host}/:_authToken=\${NPM_TOKEN}\n`
      );
      if (packageManager === 'pnpm') {
        publishEnv.npm_config_userconfig = npmrcPath;
      }
      console.log(`🔑 Using NPM_TOKEN for authentication`);
    }

    console.log(`✅ Created placeholder package files`);

    if (opts.dryRun) {
      console.log(`\n🔍 Dry run mode - package created but not published`);
      console.log(`📁 Package location: ${pkgDir}`);
      console.log(`\nTo publish manually:`);
      console.log(`  cd ${pkgDir}`);
      console.log(`  ${packageManager} publish --registry ${opts.registry}${packageManager === 'pnpm' ? ' --no-git-checks' : ''}${pkgName.startsWith('@') ? ' --access ' + opts.access : ''}`);
      return;
    }

    console.log(`\n📤 Publishing package to npm with ${packageManager}...`);

    const publishArgs = ['publish', '--registry', opts.registry];
    if (packageManager === 'pnpm') {
      // The temp dir is not a git repository; skip pnpm's branch/clean-tree checks.
      publishArgs.push('--no-git-checks');
    }
    if (pkgName.startsWith('@')) {
      publishArgs.push('--access', opts.access);
    }
    if (npmToken && packageManager === 'npm') {
      publishArgs.push('--userconfig', join(pkgDir, '.npmrc'));
    }

    try {
      const publishCommand = packageManager === 'pnpm' ? resolvePnpmCommand(publishArgs) : resolveNpmCommand(publishArgs);
      // Keep npm's browser/2FA instructions visible while retaining stderr
      // for the already-published-version check below.
      await new Promise((resolve, reject) => {
        const child = spawn(publishCommand.command, publishCommand.args, {
          cwd: pkgDir,
          env: publishEnv,
          stdio: ['inherit', 'inherit', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
          stderr += chunk;
          process.stderr.write(chunk);
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (code === 0) return resolve();
          const error = new Error(`${packageManager} publish failed (${signal || code})`);
          error.stderr = stderr;
          reject(error);
        });
      });
      console.log(`\n✅ Successfully published: ${pkgName}`);
    } catch (publishError) {
      if (publishError.code === 'ENOENT') {
        // Do not fall back to another package manager: it would use different credentials.
        throw new Error(`${packageManager} was not found. This CLI was launched by ${packageManager}, so it publishes with ${packageManager}. Install ${packageManager}, or run this CLI with ${packageManager === 'pnpm' ? 'npx to publish with npm' : 'pnpm dlx to publish with pnpm'}.`);
      }
      const stderr = publishError.stderr?.toString() ?? '';
      // pnpm 12 wraps long error lines with box-drawing characters, so compare with whitespace collapsed.
      if (stderr.replace(/[\s│]+/g, ' ').includes('cannot publish over the previously published versions')) {
        console.log(`\nℹ️  Package "${pkgName}" version ${opts.packageVersion} was previously published (and possibly unpublished). Skipping placeholder publish.`);
        return;
      }
      throw publishError;
    }
  } finally {
    if (!opts.dryRun) {
      try {
        await rm(pkgDir, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temp directory`);
      } catch (cleanupError) {
        console.warn(`⚠️  Could not clean up temp directory: ${cleanupError.message}`);
      }
    }
  }
}

// Interactive settings use the npm login session for publishing as well.
const packageManager = configureSettings ? 'npm' : detectPackageManager();
console.log(`🧰 Package manager: ${packageManager}`);
// Existing packages can be configured without publishing another version.
let completedStep = 'No changes completed';
try {
  if (configureSettings && packageExists()) {
    console.log(`📦 Package already exists: ${packageName}. Skipping placeholder publish.`);
    completedStep = 'Existing package found';
  } else {
    await publishPlaceholder(packageName, {
      packageManager,
      registry: values.registry,
      access: values.access,
      dryRun: values['dry-run'],
      packageVersion: values['package-version']
    });
    completedStep = 'Placeholder publish step completed';
    if (configureSettings) await waitForPackage();
  }
  if (configureGitHub) {
    console.log(`\n🔗 Configuring GitHub Actions trusted publishing for: ${packageName}`);
    runNpm(trustArgs, { stdio: 'inherit' });
    completedStep = 'Trusted Publisher configured';
    console.log(`✅ ${completedStep}`);
  }
  if (values.mfa !== undefined) {
    console.log(`\n🔒 Setting MFA requirement to "${values.mfa}" for: ${packageName}`);
    runNpm(mfaArgs, { stdio: 'inherit' });
    completedStep = `MFA requirement set to "${values.mfa}"`;
    console.log(`✅ ${completedStep}`);
  }
} catch (error) {
  console.error(`\n❌ ${configureSettings ? 'Package setup failed' : 'Failed to publish placeholder package'}`);
  console.error(`Error: ${error.message}`);
  if (configureSettings) {
    console.error(`Last completed step: ${completedStep}. Earlier changes have not been rolled back.`);
    console.error(`Package settings require interactive authentication. Run npm login --registry ${values.registry} and retry, completing the 2FA prompts.`);
    if (!process.env.NPM_SETUP_EPHEMERAL_AUTH) console.error(`When finished: npm logout --registry ${values.registry}`);
  }
  process.exit(1);
}

if (!values['dry-run']) {
  console.log(`\n🔗 View your package at: https://www.npmjs.com/package/${packageName}`);
  console.log(`\nNext steps:`);
  if (!configureGitHub) {
    console.log(`Configure OIDC trusted publishing at https://www.npmjs.com/package/${packageName}/access`);
  }
  console.log(`Set up your CI/CD workflow to publish with OIDC`);
  if (configureSettings && !process.env.NPM_SETUP_EPHEMERAL_AUTH) console.log(`When finished: npm logout --registry ${values.registry}`);
}
