import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import packageUtils from '@monorepo-utils/package-utils';
import { parseDocument } from 'yaml';
import { prompt as ask, Cancelled } from './terminal.js';

const { getPackages } = packageUtils;

async function choose(message, choices) {
  return ask({ type: 'select', message, choices: choices.map(choice => ({ title: choice.label, value: choice.value })) });
}

async function choosePackages(packages, root) {
  return ask({
    type: 'multiselect', message: 'Which packages should be configured?',
    choices: packages.map(pkg => ({
      title: `${pkg.packageJSON.name} (${relative(root, join(pkg.location, 'package.json')).replaceAll('\\', '/')})`,
      value: pkg.packageJSON.name
    }))
  });
}

async function suggestedEnvironment(root, workflow) {
  if (!/^[^/\\]+\.ya?ml$/.test(workflow)) return '';
  let document;
  try {
    const parsed = parseDocument(await readFile(join(root, '.github', 'workflows', workflow), 'utf8'), { logLevel: 'silent' });
    if (parsed.errors.length) throw new Error('Invalid workflow YAML');
    document = parsed.toJS();
  } catch (error) {
    if (error.code !== 'ENOENT') console.log('Could not read workflow settings. Enter the environment manually.');
    return '';
  }
  const names = new Set();
  let dynamic = false;
  for (const job of Object.values(document?.jobs || {})) {
    const name = typeof job?.environment === 'string' ? job.environment : job?.environment?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (name.includes('${{')) dynamic = true;
    else names.add(name.trim());
  }
  if (names.size === 1 && !dynamic) return [...names][0];
  if (dynamic) console.log('The workflow uses a runtime environment name. Choose or enter the name used for publishing.');
  if (names.size) return choose('Which environment should be used?', [
    ...[...names].sort().map(name => ({ label: name, value: name })),
    { label: 'None / enter another environment', value: '' }
  ]);
  return '';
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

async function readPackage(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${join(directory, 'package.json')}`, { cause: error });
  }
}

function githubRepository(value) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.replace(/^git\+/, '').replace(/\.git\/?$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(candidate)) return candidate;
  const ssh = candidate.match(/^(?:git@github\.com:|github:)([^/]+\/[^/]+)$/);
  if (ssh) return ssh[1];
  try {
    const url = new URL(candidate);
    const repository = url.pathname.replace(/^\/|\/$/g, '');
    if (url.hostname === 'github.com' && /^[\w.-]+\/[\w.-]+$/.test(repository)) return repository;
  } catch {}
  return undefined;
}

// Read package-manager definitions rather than recursively scanning every
// package.json (which would also pick up fixtures and installed dependencies).
async function discoverPackages(root, rootPackage) {
  const packages = [{ location: root, packageJSON: rootPackage }, ...getPackages(root)];
  const seen = new Set();
  return packages.filter(pkg => {
    const location = resolve(pkg.location);
    if (seen.has(location) || !pkg.packageJSON.name || pkg.packageJSON.private === true) return false;
    seen.add(location);
    return true;
  }).sort((a, b) => a.packageJSON.name.localeCompare(b.packageJSON.name));
}

export async function interactiveSetup({ packageName, values, cwd = process.cwd() }) {
  const root = git(cwd, 'rev-parse', '--show-toplevel') || cwd;
  const rootPackage = await readPackage(root);
  const packages = await discoverPackages(root, rootPackage);
  if (!packageName && packages.length === 0) {
    throw new Error('No publishable packages found. Check the workspace configuration or pass a package name explicitly.');
  }
  try {
    const packageNames = packageName ? [packageName] : await choosePackages(packages, root);
    packageName = packageNames[0];
    const pkg = packages.find(pkg => pkg.packageJSON.name === packageName)?.packageJSON || {};
    const repositoryValue = repository => typeof repository === 'string' ? repository : repository?.url;
    const suggestedRepository = values['github.repo'] || githubRepository(git(root, 'remote', 'get-url', 'origin'))
      || githubRepository(repositoryValue(pkg.repository)) || githubRepository(repositoryValue(rootPackage.repository));
    let repository = values['github.repo'];
    if (!repository) {
      repository = githubRepository(await ask({
        type: 'text', message: 'GitHub repository (owner/repo)', initial: suggestedRepository || '',
        validate: value => Boolean(githubRepository(value)) || 'Enter a GitHub repository in owner/repo format.'
      }));
    }
    let workflow = values['github.file'];
    if (!workflow) {
      let files;
      try {
        files = await readdir(join(root, '.github', 'workflows'), { withFileTypes: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        files = [];
      }
      const workflows = files.filter(file => file.isFile() && /\.ya?ml$/.test(file.name)).map(file => file.name).sort();
      if (workflows.length === 0) throw new Error('No workflows found in .github/workflows. Create a publishing workflow or pass --github.file explicitly.');
      workflow = await choose('Which workflow publishes the package?', workflows.map(file => ({ label: file, value: file })));
    }
    const environment = values['github.env'] ?? (await ask({
      type: 'text', message: 'GitHub Actions environment (leave empty if unused)',
      initial: await suggestedEnvironment(root, workflow)
    })).trim();
    const mfa = values.mfa ?? 'publish';
    const mfaDescription = {
      publish: 'require 2FA; disallow access tokens; allow trusted publishing',
      automation: 'require 2FA or an access token with bypass 2FA',
      none: 'no package-level 2FA requirement'
    }[mfa];
    console.log(`\nConfigure packages:\n  ${packageNames.length === 1 ? 'Package' : 'Packages'}: ${packageNames.join(', ')}\n  Repository: ${repository}\n  Workflow: ${workflow}\n  Environment: ${environment || '(none)'}\n  MFA: ${mfa} (${mfaDescription || 'invalid policy'})\n  Registry: ${values.registry}\n  Access: ${values.access}\n  Placeholder: ${values['package-version']} (only if the package does not exist)`);
    if (!values['dry-run']) {
      const confirmed = await ask({
        type: 'confirm', message: 'Publish a placeholder if needed and apply these settings?', initial: false
      });
      if (!confirmed) {
        console.log('Setup cancelled. No registry changes made.');
        return null;
      }
    }
    return {
      packageNames,
      values: { 'github.repo': repository, 'github.file': workflow, ...(environment && { 'github.env': environment }), mfa }
    };
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    console.log('Setup cancelled. No registry changes made.');
    return null;
  }
}
