# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool to set up OIDC trusted publishing for npm packages. It publishes a minimal placeholder package. With `--github.repo` / `--github.file` and/or `--mfa`, it configures package settings interactively after `npm login`; existing packages skip publishing. Without these flags, users configure settings on npmjs.com.

`npm trust` requires npm >= 11.15.0 and account-level 2FA. Bypass-2FA Granular Access Tokens cannot change access/trust settings. For interactive setup, require `NPM_TOKEN` to be unset and use local npm login credentials with inherited stdio for npm authentication prompts. Do not infer token type from credential source or prefix; `npm whoami` only verifies identity. Non-interactive `NPM_TOKEN` use remains placeholder-only. Dry runs with settings flags must not contact or mutate the registry.

## Commands

```bash
# Run CLI locally
./bin/cli.js <package-name> [options]

# Run E2E tests (Node.js 22+)
npm test
```

No build step — the CLI is a single ES module file (`bin/cli.js`) using only Node.js built-ins.

## Tests

`test/*.test.js` are E2E tests using `node:test`. They run the CLI with the real npm and pnpm CLIs (pnpm tests are skipped when pnpm is not on PATH) against a fake registry (`test/helpers/fake-registry.js`) that listens on `127.0.0.1` and records every request, including the published tarball contents.

`test/helpers/sandbox.js` builds an isolated environment for each test: HOME, XDG/AppData dirs, npm userconfig/globalconfig/cache and temp dirs point into a throwaway directory, and the parent environment is not inherited (only PATH-related variables), so real credentials such as `~/.npmrc` or `NPM_TOKEN` are never read. Tests must never point at a real registry; `createSandbox` refuses any registry URL other than `http://127.0.0.1:<port>/`.

## Architecture

All logic is in `bin/cli.js`. Key function:

- `publishPlaceholder(pkgName, opts)` — creates temp dir with placeholder package.json/README and publishes; swallows "cannot publish over the previously published versions" so re-runs after unpublish do not abort the rest of the flow
- `detectPackageManager()` / `resolveNpmCommand()` / `resolvePnpmCommand()` — choose and locate the package manager used for publishing (Windows: run the entry script with Node instead of the `.cmd` shim)

Package manager: `detectPackageManager()` picks pnpm when `npm_config_user_agent` starts with `pnpm/` (`pnpm dlx` / `pnpx`), otherwise npm (npx, direct run, unknown). `npm_execpath` is not used for detection (pnpm 10 does not set it for `pnpm dlx`); `resolvePnpmCommand()` only uses it to locate the launching pnpm. Never retry with the other package manager on failure.

Interactive settings flags always select npm for both publishing and settings so that the entire setup uses the credentials from `npm login`. Use `resolveNpmCommand` for all npm subprocesses to preserve Windows support.

Authentication: When `NPM_TOKEN` env var is set, with npm it creates a temporary `.npmrc` inside the package temp dir and passes it via `--userconfig` to `npm publish`. The `.npmrc` is cleaned up with the temp dir. With pnpm, the token is passed via `pnpm_config_//<host>/:_authToken` and `npm_config_//<host>/:_authToken` env vars of the `pnpm publish` child process (pnpm 11+ ignores `${...}` in a project `.npmrc` and has no `--userconfig`).

## Registry

User's `~/.npmrc` may set a custom registry. The CLI explicitly passes `--registry` to `npm publish`.

## Release

Releases are handled via GitHub Actions (`create-release-pr.yml` → `release.yml`). The release workflow publishes to npm using OIDC provenance.
