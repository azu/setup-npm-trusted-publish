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
Usage: setup-npm-trusted-publish <package-name>

Setup npm package for trusted publishing with OIDC by publishing a placeholder package

Arguments:
  <package-name>  The name of the npm package to setup

Options:
  -h, --help      Show help
  -v, --version   Show version
  --dry-run       Create the package but don't publish
  --access        Access level for scoped packages (public/restricted) [default: public]
  --registry      npm registry URL [default: https://registry.npmjs.org]

Example:
  setup-npm-trusted-publish my-package
  setup-npm-trusted-publish @scope/my-package

Environment:
  NPM_TOKEN        npm auth token for publishing (optional, uses .npmrc in package dir)

Note:
  This tool creates and publishes a placeholder package for OIDC setup.
  The package contains only a README.md that clearly indicates it's for
  OIDC configuration purposes only.
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

// Create temp directory
const tempDirName = `npm-oidc-setup-${randomBytes(8).toString('hex')}`;
const packageDir = join(tmpdir(), tempDirName);
await mkdir(packageDir, { recursive: true });

console.log(`📦 Creating placeholder package: ${packageName}`);
console.log(`📁 Temp directory: ${packageDir}`);

try {
  // Create package.json
  const packageJson = {
    name: packageName,
    version: '0.0.1',
    description: `OIDC trusted publishing setup package for ${packageName}`,
    keywords: ['oidc', 'trusted-publishing', 'setup']
  };

  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n'
  );

  // Create README.md with clear indication
  const readmeContent = `# ${packageName}

## ⚠️ IMPORTANT NOTICE ⚠️

**This package is created solely for the purpose of setting up OIDC (OpenID Connect) trusted publishing with npm.**

This is **NOT** a functional package and contains **NO** code or functionality beyond the OIDC setup configuration.

## Purpose

This package exists to:
1. Configure OIDC trusted publishing for the package name \`${packageName}\`
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

  await writeFile(join(packageDir, 'README.md'), readmeContent);

  // If NPM_TOKEN is set, create .npmrc for authentication
  const npmToken = process.env.NPM_TOKEN;
  if (npmToken) {
    const registryUrl = new URL(values.registry);
    await writeFile(
      join(packageDir, '.npmrc'),
      `registry=${values.registry}\n//${registryUrl.host}/:_authToken=\${NPM_TOKEN}\n`
    );
    console.log(`🔑 Using NPM_TOKEN for authentication`);
  }

  console.log(`✅ Created placeholder package files`);

  if (values['dry-run']) {
    console.log(`\n🔍 Dry run mode - package created but not published`);
    console.log(`📁 Package location: ${packageDir}`);
    console.log(`\nTo publish manually:`);
    console.log(`  cd ${packageDir}`);
    console.log(`  npm publish --registry ${values.registry}${packageName.startsWith('@') ? ' --access ' + values.access : ''}`);
  } else {
    // Publish the package
    console.log(`\n📤 Publishing package to npm...`);
    
    const publishArgs = ['publish', '--registry', values.registry];
    if (packageName.startsWith('@')) {
      publishArgs.push('--access', values.access);
    }
    if (npmToken) {
      publishArgs.push('--userconfig', join(packageDir, '.npmrc'));
    }

    try {
      execFileSync('npm', publishArgs, {
        cwd: packageDir,
        stdio: 'inherit',
        shell: true
      });
      
      console.log(`\n✅ Successfully published: ${packageName}`);
      console.log(`\n🔗 View your package at: https://www.npmjs.com/package/${packageName}`);
      console.log(`\nNext steps:`);
      console.log(`1. Go to https://www.npmjs.com/package/${packageName}/access`);
      console.log(`2. Configure OIDC trusted publishing`);
      console.log(`3. Set up your CI/CD workflow to publish with OIDC`);
    } catch (publishError) {
      console.error(`\n❌ Failed to publish package`);
      console.error(`Error: ${publishError.message}`);
      console.log(`\n📁 Package files are still available at: ${packageDir}`);
      console.log(`You can try publishing manually:`);
      console.log(`  cd ${packageDir}`);
      console.log(`  npm publish --registry ${values.registry}${packageName.startsWith('@') ? ' --access ' + values.access : ''}`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
} finally {
  // Clean up temp directory if not in dry-run mode
  if (!values['dry-run']) {
    try {
      await rm(packageDir, { recursive: true, force: true });
      console.log(`\n🧹 Cleaned up temp directory`);
    } catch (cleanupError) {
      console.warn(`⚠️  Could not clean up temp directory: ${cleanupError.message}`);
    }
  }
}