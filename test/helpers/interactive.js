import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './sandbox.js';

// Send real keyboard events after each prompt has rendered. No prompt answers
// are injected into the application or its UI library.
export function interactiveKeys({ packageKeys = ' \r', workflowKeys = '\x1b[B\r', environment = '', confirm } = {}) {
  const steps = [
    { waitFor: /(?:◯|\( \))\s+@test\//, keys: packageKeys },
    { waitFor: 'GitHub repository (owner/repo)', keys: '\r' },
    { waitFor: /[❯>]\s+checks\.yml/, keys: workflowKeys },
    { waitFor: 'GitHub Actions environment (leave empty if unused)', keys: `${environment}\r` }
  ];
  if (confirm !== undefined) steps.push({ waitFor: 'Publish a placeholder if needed and apply these settings?', keys: confirm ? 'y' : 'n' });
  return steps;
}

export async function createProject(ctx, type = 'npm') {
  const root = ctx.sandbox.dirs.work;
  const manifest = { name: 'workspace-root', private: true };
  if (type === 'npm') manifest.workspaces = ['packages/*'];
  if (type === 'yarn') manifest.workspaces = { packages: ['packages/*'] };
  if (type === 'single') {
    manifest.name = '@test/single';
    manifest.private = false;
    manifest.repository = 'https://github.com/example/project.git';
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  if (type === 'pnpm') await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  if (type === 'lerna') await writeFile(join(root, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }));
  if (type !== 'single') {
    for (const name of ['alpha', 'beta', 'private']) {
      const directory = join(root, 'packages', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@test/${name}`, private: name === 'private' }));
    }
    // This package is not in a workspace and must not be offered.
    await mkdir(join(root, 'fixtures'), { recursive: true });
    await writeFile(join(root, 'fixtures', 'package.json'), JSON.stringify({ name: '@test/fixture' }));
  }
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  for (const file of ['checks.yml', 'release.yml']) {
    await writeFile(join(root, '.github', 'workflows', file), 'name: Test\non: workflow_dispatch\n');
  }
  for (const args of [
    ['init', '--quiet'],
    ['remote', 'add', 'origin', 'git@github.com:example/project.git']
  ]) {
    const result = await run('git', args, { cwd: root, env: ctx.sandbox.env });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  }
  return root;
}
