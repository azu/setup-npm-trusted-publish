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

No build step. `bin/cli.js` runs the publish/settings flow; `bin/interactive.js` uses `@monorepo-utils/package-utils` for discovery and `yaml` for workflow environment defaults. `bin/terminal.js` implements arrow-key selection, filtering, text, and confirmation with Node.js built-ins and no UI dependencies. Runtime dependencies are bundled in the published package so npx/pnpm execution remains self-contained. Run `npm ci` before tests.

## Tests

`test/*.test.js` are E2E tests using `node:test`. They run the CLI with the real npm and pnpm CLIs (pnpm tests are skipped when pnpm is not on PATH) against a fake registry (`test/helpers/fake-registry.js`) that listens on `127.0.0.1` and records every request, including the published tarball contents.

`test/helpers/sandbox.js` builds an isolated environment for each test: HOME, XDG/AppData dirs, npm userconfig/globalconfig/cache and temp dirs point into a throwaway directory, and the parent environment is not inherited (only PATH-related variables), so real credentials such as `~/.npmrc` or `NPM_TOKEN` are never read. Tests must never point at a real registry; `createSandbox` refuses any registry URL other than `http://127.0.0.1:<port>/`.

## Architecture

The publish/settings flow is in `bin/cli.js`. Key function:

- `publishPlaceholder(pkgName, opts)` — creates temp dir with placeholder package.json/README and publishes; swallows "cannot publish over the previously published versions" so re-runs after unpublish do not abort the rest of the flow
- `detectPackageManager()` / `resolveNpmCommand()` / `resolvePnpmCommand()` — choose and locate the package manager used for publishing (Windows: run the entry script with Node instead of the `.cmd` shim)
- `interactiveSetup()` in `bin/interactive.js` — discover packages from workspace definitions plus the root manifest, exclude private packages, select multiple packages with filtering, choose a shared GitHub repository/workflow/environment, and confirm before reusing the normal settings flow. Batches invoke the normal CLI sequentially for each package; failures stop the batch and report completed/failed/unattempted packages. No registry access occurs before confirmation. `--interactive --dry-run` only reads local files. Test this through the real CLI in `test/npm.e2e.test.js`, sending keyboard events after prompts render (no prompt injection), including arrows, filtering, cancellation, batches, and npx packaging.
- `suggestedEnvironment()` reads static `jobs.*.environment` strings or `.name` values from the selected workflow. Multiple names prompt for a choice; expressions require manual input. Explicit `--github.env` overrides detection. Defaults remain editable and can be cleared.
- `withEphemeralAuth()` in `bin/session.js` — opt-in `--ephemeral-auth` uses an isolated cwd/userconfig/globalconfig and sanitized auth environment. Login follows interactive confirmation; one session covers the batch. Finally attempt logout on normal/error/SIGINT/SIGTERM exits, retry up to three times, and only remove the configuration after successful logout. Logout failure exits nonzero and retains protected credentials for recovery. Dry runs and cancelled confirmation never log in. Existing user/project authentication must remain untouched. Test with actual npm against the local registry, including interrupted and failed cleanup paths.

Package manager: `detectPackageManager()` picks pnpm when `npm_config_user_agent` starts with `pnpm/` (`pnpm dlx` / `pnpx`), otherwise npm (npx, direct run, unknown). `npm_execpath` is not used for detection (pnpm 10 does not set it for `pnpm dlx`); `resolvePnpmCommand()` only uses it to locate the launching pnpm. Never retry with the other package manager on failure.

Interactive settings flags always select npm for both publishing and settings so that the entire setup uses the credentials from `npm login`. Use `resolveNpmCommand` for all npm subprocesses to preserve Windows support.

Authentication: When `NPM_TOKEN` env var is set, with npm it creates a temporary `.npmrc` inside the package temp dir and passes it via `--userconfig` to `npm publish`. The `.npmrc` is cleaned up with the temp dir. With pnpm, the token is passed via `pnpm_config_//<host>/:_authToken` and `npm_config_//<host>/:_authToken` env vars of the `pnpm publish` child process (pnpm 11+ ignores `${...}` in a project `.npmrc` and has no `--userconfig`).

## Registry

User's `~/.npmrc` may set a custom registry. The CLI explicitly passes `--registry` to `npm publish`.

## Release

Releases are handled via GitHub Actions (`create-release-pr.yml` → `release.yml`). The release workflow publishes to npm using OIDC provenance.
