# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool to set up OIDC trusted publishing for npm packages. npm requires a package to exist before configuring trusted publishing — this tool handles that by publishing a minimal placeholder package. The user then configures OIDC trusted publishing manually on npmjs.com.

`npm trust` is intentionally NOT supported: it requires interactive 2FA OTP at the account level and explicitly does not accept Granular Access Tokens with bypass 2FA, which makes it unusable for the automation flow this CLI targets. See README "Why not use `npm trust`?" section.

## Commands

```bash
# Run CLI locally
./bin/cli.js <package-name> [options]
```

No build step — the CLI is a single ES module file (`bin/cli.js`) using only Node.js built-ins.

## Architecture

All logic is in `bin/cli.js`. Key functions:

- `publishPlaceholder(pkgName, opts)` — creates temp dir with placeholder package.json/README and publishes; swallows "cannot publish over the previously published versions" so re-runs after unpublish do not abort the rest of the flow
- `setMfa(pkgName, opts)` — sets MFA requirement via `npm access set mfa=...`; accepts `npmrcPath` for `NPM_TOKEN` auth

Authentication: When `NPM_TOKEN` env var is set, creates a temporary `.npmrc` and passes it via `--userconfig` (for `npm publish`) or `npm_config_userconfig` env var (for `npm access`). The `.npmrc` for the publish step lives inside the temp package dir; a separate `.npmrc` is created for `setMfa` because the publish-step temp dir is cleaned up before MFA is set.

## Registry

User's `~/.npmrc` may set a custom registry. All npm commands (`publish`, `access`) must explicitly pass `--registry`.

## npm MFA values (counterintuitive)

- `mfa=automation` — 2FA required OR granular access token with bypass 2FA (for CI/CD)
- `mfa=publish` — 2FA required AND disallow tokens (interactive only, stricter)

Ref: https://github.com/orgs/community/discussions/172886

## Release

Releases are handled via GitHub Actions (`create-release-pr.yml` → `release.yml`). The release workflow publishes to npm using OIDC provenance.
