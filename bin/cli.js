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
  -h, --help      Show help
  -v, --version   Show version
  --dry-run       Preview actions without making changes
  --access        Access level for scoped packages (public/restricted) [default: public]
  --registry      npm registry URL [default: https://registry.npmjs.org]

Examples:
  setup-npm-trusted-publish my-package
  setup-npm-trusted-publish @scope/my-package
  read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
  setup-npm-trusted-publish my-package --dry-run
  setup-npm-trusted-publish my-package --registry https://npm.example.com

After this tool publishes the placeholder, configure OIDC trusted publishing and
publishing MFA requirement at:
  https://www.npmjs.com/package/<package-name>/access

Environment:
  NPM_TOKEN   npm auth token for placeholder publish.
              If set, creates a temporary .npmrc for authentication.

Note: --github.* / --gitlab.* / --circleci.* / --mfa / --otp options were
removed in v2 because npm trust and npm access set mfa=... require interactive
2FA OTP and cannot be driven by NPM_TOKEN. Configure those manually on
npmjs.com after this CLI publishes the placeholder. See README for details.
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

    try {
      execFileSync('npm', publishArgs, {
        cwd: pkgDir,
        stdio: ['inherit', 'inherit', 'pipe']
      });
      console.log(`\n✅ Successfully published: ${pkgName}`);
    } catch (publishError) {
      const stderr = publishError.stderr?.toString() ?? '';
      process.stderr.write(stderr);
      if (stderr.includes('cannot publish over the previously published versions')) {
        console.log(`\nℹ️  Package "${pkgName}" version 0.0.1 was previously published (and possibly unpublished). Skipping placeholder publish.`);
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

if (!values['dry-run']) {
  console.log(`\n🔗 View your package at: https://www.npmjs.com/package/${packageName}`);
  console.log(`\nNext steps:`);
  console.log(`1. Go to https://www.npmjs.com/package/${packageName}/access`);
  console.log(`2. Configure OIDC trusted publishing`);
  console.log(`3. Set up your CI/CD workflow to publish with OIDC`);
}