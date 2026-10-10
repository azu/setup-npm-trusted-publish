// Isolated environment for running the CLI and real npm / pnpm in E2E tests.
// HOME, config, cache and temp dirs all point into a throwaway directory, and the
// parent environment is NOT inherited (apart from what is needed to find executables),
// so the user's real credentials (~/.npmrc, pnpm auth.ini, NPM_TOKEN, ...) are never read.
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as fsSync from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cliPath = join(repoRoot, 'bin', 'cli.js');

// Only these variables are copied from the parent process.
const PASSTHROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'WINDIR', 'windir', 'SystemDrive'];

export async function createSandbox({ registryUrl }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(registryUrl)) {
    throw new Error(`Refusing to run E2E against a non-local registry: ${registryUrl}`);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'setup-npm-trusted-publish-e2e-')));
  const dirs = {
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    state: join(root, 'state'),
    appData: join(root, 'AppData', 'Roaming'),
    localAppData: join(root, 'AppData', 'Local'),
    work: join(root, 'work')
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const userconfig = join(dirs.home, '.npmrc');
  const globalconfig = join(root, 'npmrc-global');
  await writeFile(userconfig, '');
  await writeFile(globalconfig, '');

  const env = {};
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    APPDATA: dirs.appData,
    LOCALAPPDATA: dirs.localAppData,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(dirs.cache, 'npm'),
    npm_config_registry: registryUrl,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'warn',
    pnpm_config_registry: registryUrl,
    pnpm_config_store_dir: join(dirs.data, 'pnpm-store'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  });

  return {
    root,
    dirs,
    env,
    userconfig,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 })
  };
}

// Run a command without a shell. Resolves with { code, stdout, stderr } and never rejects on a non-zero exit.
export function run(command, args, { env, cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ code: error ? error.code : 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

// `npm` is `npm.cmd` on Windows, which cannot be started without a shell; run npm's entry script with Node instead.
export function npmCommand(args) {
  if (process.platform === 'win32') {
    return { command: process.execPath, args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args] };
  }
  return { command: 'npm', args };
}

// Pack this repository into a tarball so tests can launch the CLI the way users do (npx / pnpm dlx).
export async function packCli(sandbox) {
  const npm = npmCommand(['pack', '--pack-destination', sandbox.root, '--json']);
  const result = await run(npm.command, npm.args, { env: sandbox.env, cwd: repoRoot });
  if (result.code !== 0) throw new Error(`npm pack failed:\n${result.stderr}`);
  const [{ filename }] = JSON.parse(result.stdout);
  return join(sandbox.root, filename);
}

// Collect every file under `dir` whose content contains `needle`.
export async function findFilesContaining(dir, needle) {
  const { readdir, readFile } = await import('node:fs/promises');
  const hits = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}

// Resolve the pnpm on PATH so tests can run it without a shell (pnpm installed with npm is `pnpm.cmd` on Windows).
// Returns undefined when pnpm is not installed.
export function pnpmCommand(args, { PATH = process.env.PATH ?? '' } = {}) {
  const { existsSync } = fsSync;
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    if (process.platform === 'win32') {
      if (existsSync(join(dir, 'pnpm.exe'))) return { command: join(dir, 'pnpm.exe'), args };
      if (!existsSync(join(dir, 'pnpm.cmd'))) continue;
      const script = ['pnpm.cjs', 'pnpm.mjs'].map((file) => join(dir, 'node_modules', 'pnpm', 'bin', file)).find(existsSync);
      if (script) return { command: process.execPath, args: [script, ...args] };
    } else if (existsSync(join(dir, 'pnpm'))) {
      return { command: join(dir, 'pnpm'), args };
    }
  }
  return undefined;
}
