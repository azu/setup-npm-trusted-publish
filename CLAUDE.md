# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool to set up OIDC trusted publishing for npm packages. npm requires a package to exist before configuring trusted publishing — this tool handles that by publishing a minimal placeholder package. The user then configures OIDC trusted publishing and publishing MFA requirement manually on npmjs.com.

`npm trust` and `npm access set mfa=...` are intentionally NOT supported: both require interactive 2FA OTP at the account level and reject token-based execution (`npm trust` explicitly disallows GAT with bypass 2FA per its docs; `npm access set mfa` falls back to web auth and returns `401 token is invalid`). For the non-interactive automation flow this CLI targets, only the placeholder publish step is reliable. See README "Why not use `npm trust` or `npm access set mfa=...`?" section.

## Commands

```bash
# Run CLI locally
./bin/cli.js <package-name> [options]
```

No build step — the CLI is a single ES module file (`bin/cli.js`) using only Node.js built-ins.

## Architecture

All logic is in `bin/cli.js`. Key function:

- `publishPlaceholder(pkgName, opts)` — creates temp dir with placeholder package.json/README and publishes; swallows "cannot publish over the previously published versions" so re-runs after unpublish do not abort the rest of the flow

Authentication: When `NPM_TOKEN` env var is set, creates a temporary `.npmrc` inside the package temp dir and passes it via `--userconfig` to `npm publish`. The `.npmrc` is cleaned up with the temp dir.

## Registry

User's `~/.npmrc` may set a custom registry. The CLI explicitly passes `--registry` to `npm publish`.

## Release

Releases are handled via GitHub Actions (`create-release-pr.yml` → `release.yml`). The release workflow publishes to npm using OIDC provenance.
