# setup-npm-trusted-publish

A tool to create and publish placeholder npm packages for setting up OIDC (OpenID Connect) trusted publishing.

## Background

Unlike PyPI which allows configuring OIDC for not-yet-existing packages, npm requires a package to exist before you can configure trusted publishing. This tool helps work around that limitation by automatically creating and publishing minimal placeholder packages that clearly indicate they exist solely for OIDC setup purposes.

See: 

- [GitHub Community Discussion #127011](https://github.com/orgs/community/discussions/127011)
- [Allow publishing initial version with OIDC · Issue #8544 · npm/cli](https://github.com/npm/cli/issues/8544)

## Installation

```bash
npm install -g setup-npm-trusted-publish
```

Or run directly with npx:

```bash
npx setup-npm-trusted-publish <package-name>
```

## Usage

```bash
setup-npm-trusted-publish <package-name>
```

Options:
- `--dry-run` - Create the package but don't publish
- `--access <public|restricted>` - Access level for scoped packages (default: public)
- `--registry <url>` - npm registry URL (default: `https://registry.npmjs.org`)

Environment Variables:
- `NPM_TOKEN` - npm authentication token for users who don't have npm login configured locally. If set, a temporary `.npmrc` is created in the package directory with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`. npm expands `${NPM_TOKEN}` at runtime, so the actual token is never written to disk. The `.npmrc` is cleaned up with the temporary directory after publishing.

Examples:
```bash
# Create and publish a regular package
setup-npm-trusted-publish my-package

# Create and publish a scoped package
setup-npm-trusted-publish @myorg/my-package

# Dry run (create but don't publish)
setup-npm-trusted-publish my-package --dry-run

# Use a one-time token without configuring npm login locally
read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
```

## Usage without local npm login

If you don't have npm login configured locally, you can use a one-time Granular Access Token:

1. Go to https://www.npmjs.com/settings/{user}/tokens and create a new **Granular Access Token**
2. Configure the token:
   - **Packages and scopes**: Read and write (select the target scope if publishing a scoped package)
   - **Expiration**: 7 days (shortest available, since this is one-time use)
3. Publish using the token:
   ```bash
   read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish @myorg/my-package
   ```
4. Revoke the token at https://www.npmjs.com/settings/{user}/tokens after publishing

## What it does

This tool:
1. Creates a minimal npm package in a temporary directory
2. Generates a `package.json` with basic metadata for OIDC setup
3. Creates a `README.md` that **clearly states the package is for OIDC setup only**
4. Automatically publishes the package to npm
5. Cleans up the temporary directory
6. Provides a direct link to configure OIDC at `https://www.npmjs.com/package/<package-name>/access`

The generated README explicitly indicates:
- The package is **NOT** functional
- It contains **NO** code
- It exists **ONLY** for OIDC configuration
- It should **NOT** be used as a dependency

## Workflow

1. Run this tool to create and publish a placeholder package
2. Visit the provided URL (`https://www.npmjs.com/package/<package-name>/access`) to configure OIDC trusted publishing
3. Set up your CI/CD workflow to publish the real package version with OIDC

## Example Output

```bash
$ setup-npm-trusted-publish @myorg/my-package

📦 Creating placeholder package: @myorg/my-package
📁 Temp directory: /tmp/npm-oidc-setup-abc123def456
✅ Created placeholder package files

📤 Publishing package to npm...

✅ Successfully published: @myorg/my-package

🔗 View your package at: https://www.npmjs.com/package/@myorg/my-package

Next steps:
1. Go to https://www.npmjs.com/package/@myorg/my-package/access
2. Configure OIDC trusted publishing
3. Set up your CI/CD workflow to publish with OIDC

🧹 Cleaned up temp directory
```

## Why is this needed?

npm's current implementation requires a package to exist before you can:
- Configure OIDC trusted publishing
- Generate granular access tokens

This tool provides a responsible way to "reserve" a package name for OIDC setup by creating a package that:
- Clearly communicates its purpose
- Cannot be mistaken for a functional package
- Enables the OIDC configuration workflow

## Important Notes

- This tool is specifically for OIDC setup, not for name squatting
- The generated packages clearly indicate they are placeholders
- Always follow npm's policies and best practices
- Replace the placeholder with your actual package as soon as possible

## License

MIT
