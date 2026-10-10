#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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
    }
  },
  allowPositionals: true
});

if (values.help) {
  console.log(`
Usage: setup-npm-trusted-publish <package-name> [options]

Publishes a minimal placeholder package to npm so you can configure OIDC
trusted publishing on npmjs.com afterwards.

Arguments:
  <package-name>  The name of the npm package to setup (e.g. my-package, @scope/my-package)

Options:
  -h, --help               Show help
  -v, --version            Show version
  --dry-run                Preview actions without making changes
  --access                 Access level for scoped packages (public/restricted) [default: public]
  --registry               npm registry URL [default: https://registry.npmjs.org]
  --package-version        Version to use for the placeholder package [default: 0.0.0]

Examples:
  setup-npm-trusted-publish my-package
  setup-npm-trusted-publish @scope/my-package
  read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
  setup-npm-trusted-publish my-package --dry-run
  setup-npm-trusted-publish my-package --registry https://npm.example.com
  setup-npm-trusted-publish my-package --package-version 0.0.1

After this tool publishes the placeholder, configure OIDC trusted publishing and
publishing MFA requirement at:
  https://www.npmjs.com/package/<package-name>/access

Package manager:
  Publishes with the package manager that launched this CLI.
  pnpm dlx / pnpx: pnpm publish (uses the credentials saved by pnpm login)
  npx, a global install or anything else: npm publish

Environment:
  NPM_TOKEN   npm auth token for placeholder publish.
              npm: creates a temporary .npmrc for authentication.
              pnpm: passed to pnpm through its environment only.
`);
  process.exit(0);
}

if (values.version) {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  console.log(pkg.default.version);
  process.exit(0);
}

const packageName = positionals[0];

if (!packageName) {
  console.error('Error: Package name is required');
  console.error('Usage: setup-npm-trusted-publish <package-name>');
  process.exit(1);
}

// Validate package name
const validPackageNameRegex = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
if (!validPackageNameRegex.test(packageName)) {
  console.error(`Error: Invalid package name: ${packageName}`);
  console.error('Package names must be lowercase and can contain letters, numbers, hyphens, periods, and underscores');
  process.exit(1);
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
      if (packageManager === 'pnpm') {
        // pnpm 11+ ignores `${NPM_TOKEN}` in a project .npmrc and has no --userconfig, so pass the token
        // through the environment instead of writing it to disk: pnpm_config_ for pnpm 11.6+, npm_config_ for pnpm 10
        // (which publishes through npm).
        const authKey = `//${registryUrl.host}/:_authToken`;
        publishEnv[`pnpm_config_${authKey}`] = npmToken;
        publishEnv[`npm_config_${authKey}`] = npmToken;
      } else {
        await writeFile(
          join(pkgDir, '.npmrc'),
          `registry=${opts.registry}\n//${registryUrl.host}/:_authToken=\${NPM_TOKEN}\n`
        );
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
      execFileSync(publishCommand.command, publishCommand.args, {
        cwd: pkgDir,
        env: publishEnv,
        stdio: ['inherit', 'inherit', 'pipe']
      });
      console.log(`\n✅ Successfully published: ${pkgName}`);
    } catch (publishError) {
      if (publishError.code === 'ENOENT') {
        // Do not fall back to another package manager: it would use different credentials.
        throw new Error(`${packageManager} was not found. This CLI was launched by ${packageManager}, so it publishes with ${packageManager}. Install ${packageManager}, or run this CLI with ${packageManager === 'pnpm' ? 'npx to publish with npm' : 'pnpm dlx to publish with pnpm'}.`);
      }
      const stderr = publishError.stderr?.toString() ?? '';
      process.stderr.write(stderr);
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

// Publish placeholder package and guide manual OIDC setup
const packageManager = detectPackageManager();
console.log(`🧰 Package manager: ${packageManager}`);
try {
  await publishPlaceholder(packageName, {
    packageManager,
    registry: values.registry,
    access: values.access,
    dryRun: values['dry-run'],
    packageVersion: values['package-version']
  });
} catch (error) {
  console.error(`\n❌ Failed to publish placeholder package`);
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

if (!values['dry-run']) {
  console.log(`\n🔗 View your package at: https://www.npmjs.com/package/${packageName}`);
  console.log(`\nNext steps:`);
  console.log(`1. Go to https://www.npmjs.com/package/${packageName}/access`);
  console.log(`2. Configure OIDC trusted publishing`);
  console.log(`3. Set up your CI/CD workflow to publish with OIDC`);
}