# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool to set up OIDC trusted publishing for npm packages. npm requires a package to exist before configuring trusted publishing — this tool handles that by publishing a placeholder first, then configuring trust.

Two modes:
- **npm trust mode**: When `--github.*`/`--gitlab.*`/`--circleci.*` flags are provided (requires npm >= 11.10.0). Auto-publishes placeholder if package doesn't exist, then runs `npm trust`.
- **Legacy mode**: Publishes placeholder package only, user configures OIDC manually on npmjs.com.

## Commands

```bash
# Run tests
node --experimental-strip-types ./test/test.ts

# Run CLI locally
./bin/cli.js <package-name> [options]
```

No build step — the CLI is a single ES module file (`bin/cli.js`) using only Node.js built-ins.

## Architecture

All logic is in `bin/cli.js` (~500 lines). Key functions:

- `packageExists(pkgName, registry)` — checks if package exists on registry via `npm view`
- `publishPlaceholder(pkgName, opts)` — creates temp dir with placeholder package.json/README and publishes
- `buildTrustArgs(provider)` — constructs `npm trust` CLI arguments for github/gitlab/circleci
- `setMfa(pkgName, opts)` — sets MFA requirement via `npm access set mfa=...`

Authentication: When `NPM_TOKEN` env var is set, creates a temporary `.npmrc` and passes it via `npm_config_userconfig` environment variable (not `--userconfig` flag, which `npm trust` doesn't support).

## npm MFA values (counterintuitive)

- `mfa=automation` — 2FA required OR granular access token with bypass 2FA (for CI/CD)
- `mfa=publish` — 2FA required AND disallow tokens (interactive only, stricter)

Ref: https://github.com/orgs/community/discussions/172886

## Release

Releases are handled via GitHub Actions (`create-release-pr.yml` → `release.yml`). The release workflow publishes to npm using OIDC provenance.
