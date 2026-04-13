#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
    // Shared options
    mfa: { type: 'string' },
    otp: { type: 'string' },
    // GitHub Actions
    'github.repo': { type: 'string' },
    'github.file': { type: 'string' },
    'github.env': { type: 'string' },
    // GitLab CI/CD
    'gitlab.repo': { type: 'string' },
    'gitlab.file': { type: 'string' },
    'gitlab.env': { type: 'string' },
    // CircleCI
    'circleci.org-id': { type: 'string' },
    'circleci.project-id': { type: 'string' },
    'circleci.pipeline-definition-id': { type: 'string' },
    'circleci.vcs-origin': { type: 'string' },
    'circleci.context-id': { type: 'string' }
  },
  allowPositionals: true
});

if (values.help) {
  console.log(`
Usage: setup-npm-trusted-publish <package-name> [options]

Setup npm package for trusted publishing with OIDC.

When --github.*, --gitlab.*, or --circleci.* options are specified, runs
"npm trust" to configure trusted publishing directly (requires npm >= 11.10.0).
Otherwise, publishes a minimal placeholder package so you can configure OIDC
manually on npmjs.com.

Arguments:
  <package-name>  The name of the npm package to setup (e.g. my-package, @scope/my-package)

Options:
  -h, --help      Show help
  -v, --version   Show version
  --dry-run       Preview actions without making changes
  --access        Access level for scoped packages (public/restricted) [default: public]
  --registry      npm registry URL [default: https://registry.npmjs.org]
  --mfa           Set publishing MFA requirement after setup:
                    none:       No MFA requirement
                    automation: Require 2FA or granular access token with bypass 2FA enabled (for CI/CD)
                    publish:    Require 2FA and disallow tokens (interactive publish only)
  --otp           One-time password for 2FA (optional, npm will prompt interactively if needed)

Trusted Publisher configuration via "npm trust" (requires npm >= 11.10.0):
  Configure which CI workflow is allowed to publish this package.

  GitHub Actions:
    --github.repo   Repository that is allowed to publish (owner/repo)
    --github.file   Workflow file that triggers publishing (e.g. release.yml)
    --github.env    Environment required for publishing (optional)

  GitLab CI/CD:
    --gitlab.repo   Project that is allowed to publish (owner/repo)
    --gitlab.file   Pipeline file that triggers publishing (e.g. .gitlab-ci.yml)
    --gitlab.env    Environment required for publishing (optional)

  CircleCI:
    --circleci.org-id                 Organization allowed to publish (UUID)
    --circleci.project-id             Project allowed to publish (UUID)
    --circleci.pipeline-definition-id Pipeline that triggers publishing (UUID)
    --circleci.vcs-origin             VCS origin of the project
    --circleci.context-id             Context required for publishing (UUID, optional)

Examples:
  # Via "npm trust" (npm >= 11.10.0)
  setup-npm-trusted-publish my-package --github.repo owner/repo --github.file release.yml
  setup-npm-trusted-publish @scope/my-package \\
    --github.repo owner/repo --github.file release.yml \\
    --github.env npm --mfa publish
  setup-npm-trusted-publish @scope/my-package \\
    --gitlab.repo owner/repo --gitlab.file .gitlab-ci.yml --mfa publish
  setup-npm-trusted-publish my-package \\
    --circleci.org-id <uuid> --circleci.project-id <uuid> \\
    --circleci.pipeline-definition-id <uuid> --circleci.vcs-origin <origin>

  # Via placeholder publish (npm < 11.10.0)
  setup-npm-trusted-publish my-package
  setup-npm-trusted-publish @scope/my-package --mfa publish
  read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package

  # Other options
  setup-npm-trusted-publish my-package --github.repo owner/repo --github.file release.yml --dry-run
  setup-npm-trusted-publish my-package --registry https://npm.example.com

Environment:
  NPM_TOKEN   npm auth token for placeholder publish.
              If set, creates a temporary .npmrc for authentication.
              Not needed when using --github.* / --gitlab.* / --circleci.* options.
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

// Validate --mfa value
if (values.mfa && !['none', 'publish', 'automation'].includes(values.mfa)) {
  console.error(`Error: --mfa must be one of: none, publish, automation (got: ${values.mfa})`);
  process.exit(1);
}

function setMfa(pkgName, opts) {
  console.log(`\n🔒 Setting MFA requirement to "${opts.mfa}" for: ${pkgName}`);
  const accessArgs = ['access', 'set', `mfa=${opts.mfa}`, pkgName];
  if (opts.otp) {
    accessArgs.push('--otp', opts.otp);
  }
  accessArgs.push('--registry', opts.registry);
  const mfaEnv = { ...process.env };
  if (opts.npmrcPath) {
    mfaEnv.npm_config_userconfig = opts.npmrcPath;
  }
  try {
    execFileSync('npm', accessArgs, {
      stdio: 'inherit',
      env: mfaEnv
    });
    console.log(`✅ MFA requirement set to "${opts.mfa}"`);
  } catch (mfaError) {
    console.error(`❌ Failed to set MFA requirement`);
    console.error(`Error: ${mfaError.message}`);
    console.error(`You can set it manually: npm access set mfa=${opts.mfa} ${pkgName}`);
    process.exit(1);
  }
}

// Detect npm trust mode by checking provider-specific flags
function detectProvider() {
  if (values['github.repo'] || values['github.file']) {
    return 'github';
  }
  if (values['gitlab.repo'] || values['gitlab.file']) {
    return 'gitlab';
  }
  if (values['circleci.org-id'] || values['circleci.project-id']) {
    return 'circleci';
  }
  return null;
}

function buildTrustArgs(provider) {
  const args = ['trust', provider, packageName];

  if (provider === 'github') {
    if (!values['github.repo'] || !values['github.file']) {
      console.error('Error: --github.repo and --github.file are required for GitHub Actions');
      process.exit(1);
    }
    args.push('--file', values['github.file'], '--repo', values['github.repo']);
    if (values['github.env']) {
      args.push('--env', values['github.env']);
    }
  } else if (provider === 'gitlab') {
    if (!values['gitlab.repo'] || !values['gitlab.file']) {
      console.error('Error: --gitlab.repo and --gitlab.file are required for GitLab CI/CD');
      process.exit(1);
    }
    args.push('--file', values['gitlab.file'], '--repo', values['gitlab.repo']);
    if (values['gitlab.env']) {
      args.push('--env', values['gitlab.env']);
    }
  } else if (provider === 'circleci') {
    const required = ['circleci.org-id', 'circleci.project-id', 'circleci.pipeline-definition-id', 'circleci.vcs-origin'];
    for (const key of required) {
      if (!values[key]) {
        console.error(`Error: --${key} is required for CircleCI`);
        process.exit(1);
      }
    }
    args.push(
      '--org-id', values['circleci.org-id'],
      '--project-id', values['circleci.project-id'],
      '--pipeline-definition-id', values['circleci.pipeline-definition-id'],
      '--vcs-origin', values['circleci.vcs-origin']
    );
    if (values['circleci.context-id']) {
      args.push('--context-id', values['circleci.context-id']);
    }
  }

  args.push('--yes');

  args.push('--registry', values.registry);
  if (values.otp) {
    args.push('--otp', values.otp);
  }
  if (values['dry-run']) {
    args.push('--dry-run');
  }

  return args;
}

// Check if package already exists on the registry
function packageExists(pkgName, registry) {
  try {
    execFileSync('npm', ['view', pkgName, 'name', '--registry', registry], {
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
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
      version: '0.0.1',
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

    const npmToken = process.env.NPM_TOKEN;
    if (npmToken) {
      const registryUrl = new URL(opts.registry);
      await writeFile(
        join(pkgDir, '.npmrc'),
        `registry=${opts.registry}\n//${registryUrl.host}/:_authToken=\${NPM_TOKEN}\n`
      );
      console.log(`🔑 Using NPM_TOKEN for authentication`);
    }

    console.log(`✅ Created placeholder package files`);

    if (opts.dryRun) {
      console.log(`\n🔍 Dry run mode - package created but not published`);
      console.log(`📁 Package location: ${pkgDir}`);
      console.log(`\nTo publish manually:`);
      console.log(`  cd ${pkgDir}`);
      console.log(`  npm publish --registry ${opts.registry}${pkgName.startsWith('@') ? ' --access ' + opts.access : ''}`);
      return;
    }

    console.log(`\n📤 Publishing package to npm...`);

    const publishArgs = ['publish', '--registry', opts.registry];
    if (pkgName.startsWith('@')) {
      publishArgs.push('--access', opts.access);
    }
    if (npmToken) {
      publishArgs.push('--userconfig', join(pkgDir, '.npmrc'));
    }

    execFileSync('npm', publishArgs, {
      cwd: pkgDir,
      stdio: 'inherit'
    });

    console.log(`\n✅ Successfully published: ${pkgName}`);
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

const provider = detectProvider();

if (provider) {
  // Check npm version >= 11.10.0
  const npmVersionStr = execFileSync('npm', ['--version'], { encoding: 'utf-8' }).trim();
  const npmVersionParts = npmVersionStr.split('.').map(Number);
  const npmVersionNum = npmVersionParts[0] * 10000 + npmVersionParts[1] * 100 + npmVersionParts[2];
  const requiredVersionNum = 11 * 10000 + 10 * 100 + 0;

  if (npmVersionNum < requiredVersionNum) {
    console.error(`Error: npm trust requires npm >= 11.10.0 (current: ${npmVersionStr})`);
    console.error('Update npm with: npm install -g npm@latest');
    process.exit(1);
  }

  // Publish placeholder if package does not exist yet
  if (!packageExists(packageName, values.registry)) {
    console.log(`📦 Package "${packageName}" not found on registry. Publishing placeholder first...`);
    try {
      await publishPlaceholder(packageName, {
        registry: values.registry,
        access: values.access,
        dryRun: values['dry-run']
      });
    } catch (publishError) {
      console.error(`\n❌ Failed to publish placeholder package`);
      console.error(`Error: ${publishError.message}`);
      process.exit(1);
    }

    if (values['dry-run']) {
      console.log(`\n🔍 Dry run mode - skipping npm trust configuration`);
      process.exit(0);
    }
  }

  const trustArgs = buildTrustArgs(provider);

  // Create temporary .npmrc for NPM_TOKEN authentication
  const npmToken = process.env.NPM_TOKEN;
  let trustTempDir;
  let trustNpmrcPath;
  const trustEnv = { ...process.env };
  if (npmToken) {
    trustTempDir = join(tmpdir(), `npm-trust-${randomBytes(8).toString('hex')}`);
    await mkdir(trustTempDir, { recursive: true });
    const registryUrl = new URL(values.registry);
    trustNpmrcPath = join(trustTempDir, '.npmrc');
    await writeFile(
      trustNpmrcPath,
      `registry=${values.registry}\n//${registryUrl.host}/:_authToken=\${NPM_TOKEN}\n`
    );
    trustEnv.npm_config_userconfig = trustNpmrcPath;
    console.log(`🔑 Using NPM_TOKEN for authentication`);
  }

  console.log(`📦 Configuring trusted publishing for: ${packageName} (${provider})`);

  try {
    execFileSync('npm', trustArgs, {
      stdio: 'inherit',
      env: trustEnv
    });
    console.log(`\n✅ Successfully configured trusted publishing for: ${packageName}`);
  } catch (trustError) {
    console.error(`\n❌ Failed to configure trusted publishing`);
    console.error(`Error: ${trustError.message}`);
    process.exit(1);
  }

  // Set MFA requirement if specified
  if (values.mfa && !values['dry-run']) {
    setMfa(packageName, { ...values, npmrcPath: trustNpmrcPath });
  }

  // Clean up temporary .npmrc
  if (trustTempDir) {
    try {
      await rm(trustTempDir, { recursive: true, force: true });
    } catch {}
  }

  process.exit(0);
}

// Legacy mode: publish placeholder package and guide manual OIDC setup
try {
  await publishPlaceholder(packageName, {
    registry: values.registry,
    access: values.access,
    dryRun: values['dry-run']
  });
} catch (error) {
  console.error(`\n❌ Failed to publish placeholder package`);
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// Set MFA requirement if specified
if (values.mfa && !values['dry-run']) {
  setMfa(packageName, values);
}

if (!values['dry-run']) {
  console.log(`\n🔗 View your package at: https://www.npmjs.com/package/${packageName}`);
  console.log(`\nNext steps:`);
  console.log(`1. Go to https://www.npmjs.com/package/${packageName}/access`);
  console.log(`2. Configure OIDC trusted publishing`);
  console.log(`3. Set up your CI/CD workflow to publish with OIDC`);
}