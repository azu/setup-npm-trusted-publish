# setup-npm-trusted-publish

A tool to setup OIDC (OpenID Connect) trusted publishing for npm packages.

When `--github.*`, `--gitlab.*`, or `--circleci.*` options are specified, configures trusted publishing directly via [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust) (requires npm >= 11.10.0). Otherwise, publishes a minimal placeholder package so you can configure OIDC manually on npmjs.com.

## Background

Unlike PyPI which allows configuring OIDC for not-yet-existing packages, npm requires a package to exist before you can configure trusted publishing. This tool helps work around that limitation in two ways:

1. Via `npm trust` (npm >= 11.10.0): Configures trusted publishing directly without publishing a placeholder
2. Via placeholder publish (npm < 11.10.0): Creates and publishes a minimal placeholder package

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
Trusted Publisher configuration via `npm trust` (requires npm >= 11.10.0):
- `--github.repo <owner/repo>` - Repository that is allowed to publish
- `--github.file <workflow.yml>` - Workflow file that triggers publishing
- `--github.env <environment>` - Environment required for publishing (optional)
- `--gitlab.repo <owner/repo>` - Project that is allowed to publish
- `--gitlab.file <pipeline.yml>` - Pipeline file that triggers publishing
- `--gitlab.env <environment>` - Environment required for publishing (optional)
- `--circleci.org-id <uuid>` - Organization allowed to publish
- `--circleci.project-id <uuid>` - Project allowed to publish
- `--circleci.pipeline-definition-id <uuid>` - Pipeline that triggers publishing
- `--circleci.vcs-origin <origin>` - VCS origin of the project
- `--circleci.context-id <uuid>` - Context required for publishing (optional)

Environment Variables:
- `NPM_TOKEN` - npm authentication token for users who don't have npm login configured locally. If set, a temporary `.npmrc` is created in the package directory with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`. npm expands `${NPM_TOKEN}` at runtime, so the actual token is never written to disk. The `.npmrc` is cleaned up with the temporary directory after publishing.

Examples:
```bash
# Via "npm trust" (npm >= 11.10.0)
setup-npm-trusted-publish my-package --github.repo owner/repo --github.file release.yml --mfa publish
setup-npm-trusted-publish @myorg/my-package \
  --github.repo myorg/my-repo --github.file release.yml \
  --github.env npm --mfa publish
setup-npm-trusted-publish @myorg/my-package \
  --gitlab.repo myorg/my-repo --gitlab.file .gitlab-ci.yml --mfa publish
setup-npm-trusted-publish my-package \
  --circleci.org-id <uuid> --circleci.project-id <uuid> \
  --circleci.pipeline-definition-id <uuid> --circleci.vcs-origin <origin>

# Via placeholder publish (npm < 11.10.0)
setup-npm-trusted-publish my-package
setup-npm-trusted-publish @myorg/my-package --mfa publish
read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package

# Other options
setup-npm-trusted-publish my-package --github.repo owner/repo --github.file release.yml --dry-run
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

### Via `npm trust` (npm >= 11.10.0)

When `--github.*`, `--gitlab.*`, or `--circleci.*` options are specified, this tool runs [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust) to configure trusted publishing directly. No placeholder package is published.

```bash
setup-npm-trusted-publish @myorg/my-package --github.repo myorg/my-repo --github.file release.yml
```

### Via placeholder publish (npm < 11.10.0)

Without `--github.*` / `--gitlab.*` / `--circleci.*` options, this tool:
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
