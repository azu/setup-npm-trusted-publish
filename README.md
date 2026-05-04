# setup-npm-trusted-publish

A tool to setup OIDC (OpenID Connect) trusted publishing for npm packages.

It publishes a minimal placeholder package so you can configure OIDC trusted publishing on npmjs.com afterwards.

## Background

Unlike PyPI which allows configuring OIDC for not-yet-existing packages, npm requires a package to exist before you can configure trusted publishing. This tool helps work around that limitation by creating and publishing a minimal placeholder package.

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
- `--mfa <none|automation|publish>` - Set publishing MFA requirement. `automation`: require 2FA or granular access token with bypass 2FA enabled (for CI/CD). `publish`: require 2FA and disallow tokens (interactive publish only)
- `--otp <code>` - One-time password for 2FA

Environment Variables:
- `NPM_TOKEN` - npm authentication token for users who don't have npm login configured locally. If set, a temporary `.npmrc` is created in the package directory with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`. npm expands `${NPM_TOKEN}` at runtime, so the actual token is never written to disk. The `.npmrc` is cleaned up with the temporary directory after publishing.

Examples:
```bash
setup-npm-trusted-publish my-package
setup-npm-trusted-publish @myorg/my-package --mfa publish
read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
setup-npm-trusted-publish my-package --dry-run
setup-npm-trusted-publish my-package --registry https://npm.example.com
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

## Why not use `npm trust`?

npm 11.10.0+ provides an `npm trust` command that can configure trusted publishing without publishing a placeholder. However, it has a significant limitation that makes it unsuitable for this tool's automation use case:

> Granular Access Tokens (GAT) with the bypass 2FA option are not supported. Legacy basic auth (username and password) credentials will not work for trust commands or endpoints. Two-factor authentication must be enabled at the account level.
>
> — [npm-trust documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust)

In short, `npm trust` requires interactive 2FA OTP and cannot be driven by `NPM_TOKEN` (automation token / GAT with bypass 2FA). For non-interactive setup flows that this CLI targets, the placeholder publish + manual web UI configuration is the only reliable path. If `npm trust` works for you interactively, you can run it directly without this tool.

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
