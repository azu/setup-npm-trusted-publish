import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function withEphemeralAuth({ registry, npmCommand }, operation) {
  const cwd = await mkdtemp(join(tmpdir(), 'npm-setup-session-'));
  const userconfig = join(cwd, 'user.npmrc');
  const globalconfig = join(cwd, 'global.npmrc');
  await writeFile(userconfig, '', { mode: 0o600 });
  await writeFile(globalconfig, '', { mode: 0o600 });
  // Use an empty working directory and configuration so project .npmrc files
  // and inherited auth settings cannot override the temporary npm session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key) &&
    !/^(?:npm|pnpm)_config_.*(?:auth|token|password|username|certfile|keyfile|userconfig|globalconfig|scope|user_agent|:registry$)/i.test(key)));
  Object.assign(env, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, NPM_SETUP_EPHEMERAL_AUTH: '1' });
  let activeChild, interrupted = 0, closing = false;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    interrupted = signal === 'SIGINT' ? 130 : 143;
    if (!closing) activeChild?.kill(signal);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const run = (command, args, timeout = 0) => new Promise(resolve => {
    if (interrupted && !closing) return resolve(interrupted);
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    activeChild = child;
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout) : undefined;
    const finish = code => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      resolve(code);
    };
    child.once('error', error => { console.error(error.message); finish(1); });
    child.once('close', code => finish(code ?? 1));
  });
  const npm = (args, timeout) => {
    const resolved = npmCommand(args);
    return run(resolved.command, resolved.args, timeout);
  };
  let status = 1, loggedIn = false;
  try {
    console.log('Logging in with a temporary npm session...');
    status = await npm(['login', '--registry', registry, '--auth-type', 'web']);
    loggedIn = status === 0;
    if (loggedIn && !interrupted) status = await operation({ run, cwd, env });
  } catch (error) {
    console.error(`Temporary session setup failed: ${error.message}`);
    status = 1;
  } finally {
    closing = true;
    // A failed or interrupted login may still have written credentials.
    const hasCredentials = /:(?:_authToken|_auth|_password)\s*=/.test(await readFile(userconfig, 'utf8').catch(() => ''));
    let loggedOut = !loggedIn && !hasCredentials;
    try {
      if (!loggedOut) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`Logging out temporary npm session (${attempt}/3)...`);
          const result = await npm(['logout', '--registry', registry, '--fetch-retries', '0', '--fetch-timeout', '10000'], 15000);
          if (result === 0) { loggedOut = true; break; }
          if (attempt < 3) await delay(attempt * 1000);
        }
      }
      if (loggedOut) {
        await rm(cwd, { recursive: true, force: true });
        console.log('Temporary npm authentication cleaned up.');
      } else {
        status = 1;
        console.error('Temporary session logout failed. The command has not completed successfully.');
        console.error(`Authentication file retained for retry: ${userconfig}`);
        console.error(`Retry npm logout with --registry ${registry} and --userconfig pointing to that file.`);
      }
    } catch (error) {
      status = 1;
      console.error(`Temporary session cleanup failed: ${error.message}`);
    } finally {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  }
  return interrupted || status;
}
