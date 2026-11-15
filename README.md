# setup-npm-trusted-publish

A tool to setup OIDC (OpenID Connect) trusted publishing for npm packages.

It publishes a minimal placeholder package and can configure GitHub Actions trusted publishing and publishing MFA after an interactive `npm login`.

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

Or with pnpm:

```bash
pnpm dlx setup-npm-trusted-publish <package-name>
```

## Usage

```bash
setup-npm-trusted-publish <package-name>
```

Options:
- `--dry-run` - Create the package but don't publish
- `--access <public|restricted>` - Access level for scoped packages (default: public)
- `--registry <url>` - npm registry URL (default: `https://registry.npmjs.org`)
- `--package-version <version>` - Version for the placeholder package (default: `0.0.0`)
- `--mfa <none|automation|publish>` - Set publishing MFA after publishing. `publish` requires 2FA and disallows access tokens while allowing OIDC trusted publishing. `automation` allows tokens with bypass 2FA.
- `--github.repo <owner/repo>` - GitHub repository allowed to publish (requires `--github.file`)
- `--github.file <workflow.yml>` - Workflow filename inside `.github/workflows` (requires `--github.repo`)
- `--github.env <environment>` - GitHub Actions environment, if the publishing job uses one
- `--wait-timeout <seconds>` - After publishing, wait up to this many seconds for the package to become available before configuring settings (default: `300`)
- `-i, --interactive` - Select packages and a shared GitHub publishing workflow from the current repository, then confirm setup
- `--ephemeral-auth` - Log in with a temporary npm session and attempt logout on completion, failure, or interruption

Environment Variables:
- `NPM_TOKEN` - npm authentication token for users who don't have npm login configured locally. The token is never written to disk.
  - npm: a temporary `.npmrc` is created in the package directory with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`. npm expands `${NPM_TOKEN}` at runtime. The `.npmrc` is cleaned up with the temporary directory after publishing.
  - pnpm: the token is passed to `pnpm publish` through its environment (`pnpm_config_//registry.npmjs.org/:_authToken` and `npm_config_//registry.npmjs.org/:_authToken`), because pnpm 11+ does not expand `${NPM_TOKEN}` in a project `.npmrc`.

Examples:
```bash
setup-npm-trusted-publish my-package
setup-npm-trusted-publish @myorg/my-package
read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish my-package
setup-npm-trusted-publish my-package --dry-run
setup-npm-trusted-publish my-package --registry https://npm.example.com
setup-npm-trusted-publish my-package --package-version 0.0.1
```

Without `--github.*` or `--mfa`, configure trusted publishing and publishing MFA on npmjs.com under `https://www.npmjs.com/package/<package-name>/access` after publishing.

## Select packages and a workflow interactively

Run this from the repository that will publish the package:

```bash
npx --registry https://registry.npmjs.org setup-npm-trusted-publish --interactive --ephemeral-auth
```

Use ↑/↓ to move between packages and Space to check or uncheck them. Select one or more packages, then press Enter. Type to filter by package name or manifest path; checked packages stay selected when hidden by the filter. Workflow selection also supports ↑/↓, typing to filter, and Enter to confirm. Matching is case-insensitive and supports partial matches. Backspace edits the search; Escape or Ctrl+C cancels setup. The CLI suggests the GitHub repository from the `origin` remote, falling back to `package.json`'s `repository` field, and lets you edit it. The terminal UI uses Node.js built-ins and has no UI dependencies.

The selected workflow's `jobs.*.environment` (a string or an object with `name`) supplies the environment default when there is one static name. Multiple names are offered for selection; runtime expressions such as `${{ matrix.environment }}` require you to choose or enter the actual name. Enter accepts a suggested value, typing replaces it, and Backspace or Ctrl+U lets you clear it. `--github.env` overrides detection.

```text
? Which packages should be configured? ›
◉ @myorg/foo (packages/foo/package.json)
◉ @myorg/bar (packages/bar/package.json)

? GitHub repository (owner/repo) › myorg/my-repo

? Which workflow publishes the package? (type to filter, ↑/↓ to move) › release
❯ release.yml

? GitHub Actions environment (leave empty if unused) ›
```

Package discovery uses [`@monorepo-utils/package-utils`](https://github.com/azu/monorepo-utils/tree/master/packages/@monorepo-utils/package-utils) for npm/Yarn workspaces, `pnpm-workspace.yaml`, and Lerna. The root package is also offered when it has a name and is publishable. Packages with `private: true` are excluded. Discovery starts at the Git repository root, or the current directory outside Git; it does not recursively scan unrelated `package.json` files.

Workflows come from `.github/workflows/*.yml` and `*.yaml`. The CLI displays all selected settings before asking whether to publish a placeholder if needed and configure trust/MFA. MFA defaults to `publish`; existing flags such as `--github.repo`, `--github.file`, `--github.env`, and `--mfa` override the corresponding choices. `--interactive --dry-run` previews the selection without contacting the registry. Cancelling the final confirmation makes no registry changes.

All selected packages use the same repository, workflow, environment, and MFA policy. Packages are configured sequentially through the normal setup flow. If one fails, setup stops and lists completed packages, the failed package, and packages not attempted. The failed package may have completed earlier steps, as reported in its output; completed changes are retained.

With `--ephemeral-auth`, login starts after confirmation. Complete npm's browser authentication and 2FA prompts; the tool uses one temporary session for all selected packages, then logs out. Without this flag, run `npm login` before setup and `npm logout` when finished, as shown below.

### Temporary login session

`--ephemeral-auth` also works with an explicit package name and settings flags. It uses separate temporary npm configuration files and ignores inherited auth tokens, leaving existing user and project `.npmrc` files and sessions untouched. `--dry-run` and cancelled confirmation never log in.

Logout runs after success, setup errors, and Ctrl+C/SIGTERM interruption, with up to three attempts. If logout still fails, the command exits with an error and reports the protected authentication file retained for retry; use `npm logout --registry <registry> --userconfig <reported-file>` to revoke that session, then remove the temporary directory. Forced termination such as SIGKILL or a machine shutdown cannot run cleanup.

## Complete example with local npm login

Use this flow to complete setup without creating a Granular Access Token. GitHub configuration requires npm **11.15.0 or later** and account-level 2FA, as described in the [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Replace `@myorg/my-package` and `myorg/my-repo` with your package and repository. `release.yml` is the filename of the publishing workflow in `.github/workflows`; add `--github.env <environment>` if its job uses a GitHub Actions environment.

```bash
# 1. Use a local login session for this setup.
# This tool gives NPM_TOKEN precedence over local login when publishing.
unset NPM_TOKEN
npm login --registry https://registry.npmjs.org

# 2. Publish a placeholder if needed, configure Trusted Publisher, and set MFA.
npx --registry https://registry.npmjs.org setup-npm-trusted-publish @myorg/my-package \
  --github.repo myorg/my-repo \
  --github.file release.yml \
  --mfa publish

# 3. Confirm the Trusted Publisher configuration.
npm trust list @myorg/my-package --registry https://registry.npmjs.org

# 4. End the login session when finished.
npm logout --registry https://registry.npmjs.org
```

Complete the browser authentication and 2FA prompts shown by npm. The tool runs `npm trust github` with `--allow-publish`, then [`npm access set mfa=publish`](https://docs.npmjs.com/cli/v11/commands/npm-access/). `mfa=publish` disallows access-token publishing; your configured OIDC workflow can still publish. Check the package's **Publishing access** setting on npmjs.com to confirm MFA.

Existing packages skip the placeholder publish. Completed changes remain in place when another step fails. If Trusted Publisher setup succeeds but MFA fails, retry with `--mfa publish` alone to avoid creating the same trust configuration again. Run [`npm logout`](https://docs.npmjs.com/cli/v11/commands/npm-logout/) even if you stop setup partway through; it invalidates the session token. Configure your CI workflow to publish the actual package with OIDC and replace the placeholder version.

After a placeholder publish, the tool polls `npm view --prefer-online` every two seconds until the registry serves the package, for up to five minutes by default. Use `--wait-timeout <seconds>` to change the limit. If the wait times out, the tool stops before changing trust or MFA settings and reports that the publish step has already completed.

To configure MFA separately after publishing:

```bash
npm access set mfa=publish @myorg/my-package --registry https://registry.npmjs.org
```

## Package manager

The placeholder is published with the package manager that launched this CLI:

| How you run it | Publishes with |
|---|---|
| `pnpm dlx setup-npm-trusted-publish` / `pnpx setup-npm-trusted-publish` | `pnpm publish --no-git-checks` |
| `npx setup-npm-trusted-publish`, a global install, or anything else | `npm publish` |

The launcher is detected from the `npm_config_user_agent` environment variable (`pnpm/...` means pnpm). Your project's lockfile or `packageManager` field is not used, because the CLI publishes a placeholder from a temporary directory, not your project.

With `--github.*` or `--mfa`, publishing and settings commands always use npm and the credentials from `npm login`. pnpm's login credentials cannot be used for `npm trust` or `npm access`.

This matters for authentication: since pnpm 11, `pnpm login` saves the token in pnpm's own config (`<pnpm config>/auth.ini`, or the global `config.yaml` since pnpm 12.1) instead of `~/.npmrc`, so npm cannot use it. Running this CLI with `pnpm dlx` publishes with the credentials from `pnpm login`. See [pnpm login](https://pnpm.io/cli/login) and [.npmrc & Authentication](https://pnpm.io/npmrc).

If publishing fails, the CLI does not retry with the other package manager, since it would use different credentials.

Known limitation: with pnpm 11, a "cannot publish over the previously published versions" error is printed by pnpm but the CLI exits with an error instead of skipping, because pnpm 11 prints that error to stdout, which stays attached to your terminal so that OTP prompts keep working. With npm, pnpm 10 and pnpm 12, the CLI skips the publish as before.

## Usage without local npm login

For a placeholder-only publish without local login, you can use a one-time Granular Access Token. To also configure MFA and Trusted Publisher from this tool, use the local login flow above.

1. Go to https://www.npmjs.com/settings/{user}/tokens and create a new **Granular Access Token**
2. Configure the token:
   - **Packages and scopes**: Read and write (select the target scope if publishing a scoped package)
   - **Bypass 2FA**: Enabled for a non-interactive publish
   - **Expiration**: Choose a short expiration for this one-time use
3. Publish using the token:
   ```bash
   read -s NPM_TOKEN && export NPM_TOKEN && setup-npm-trusted-publish @myorg/my-package
   ```
4. Revoke the token at https://www.npmjs.com/settings/{user}/tokens after publishing

## What it does

1. Creates a minimal npm package in a temporary directory
2. Generates a `package.json` with basic metadata for OIDC setup
3. Creates a `README.md` that **clearly states the package is for OIDC setup only**
4. Automatically publishes the package to npm (with npm, or with pnpm when launched by pnpm)
5. Cleans up the temporary directory
6. Provides a direct link to configure OIDC at `https://www.npmjs.com/package/<package-name>/access`

The generated README explicitly indicates:
- The package is **NOT** functional
- It contains **NO** code
- It exists **ONLY** for OIDC configuration
- It should **NOT** be used as a dependency

## Authentication for package settings

Publishing a placeholder and changing package settings have different authentication requirements. npm's [Registry API documentation](https://api-docs.npmjs.com/) says that bypass-2FA Granular Access Tokens cannot change package access or Trusted Publisher settings. `npm login` provides a session for interactive authentication.

When `--github.*` or `--mfa` is specified, this tool requires `NPM_TOKEN` to be unset (or `--ephemeral-auth` to isolate authentication), verifies authentication with `npm whoami`, and lets npm handle authentication challenges. `whoami` confirms the identity, not the token type or its permission to change settings. A Granular Access Token saved in `.npmrc` may still fail at the settings step; run `npm login` again to replace it with a session. The tool does not infer token type from its prefix.

For non-interactive use, publish the placeholder with `NPM_TOKEN`, then configure settings on npmjs.com. For interactive use, follow the complete local login example above.

## Workflow

1. Log in with `npm login`, then run this tool with `--github.repo`, `--github.file`, and `--mfa publish` to publish and configure the package
2. Log out with `npm logout` after setup
3. Set up your CI/CD workflow to publish the real package version with OIDC

For the placeholder-only flow, use the provided package settings URL to configure trusted publishing manually.

## Example Output

```bash
$ setup-npm-trusted-publish @myorg/my-package

📦 Creating placeholder package: @myorg/my-package
📁 Temp directory: /tmp/npm-oidc-setup-abc123def456
✅ Created placeholder package files

📤 Publishing package to npm...

✅ Successfully published: @myorg/my-package

🧹 Cleaned up temp directory

🔗 View your package at: https://www.npmjs.com/package/@myorg/my-package

Next steps:
Configure OIDC trusted publishing at https://www.npmjs.com/package/@myorg/my-package/access
Set up your CI/CD workflow to publish with OIDC
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
