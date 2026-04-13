import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test, describe } from "node:test";

const CLI_PATH = join(import.meta.dirname, "..", "bin", "cli.js");

function run(
  args: string[],
  options?: ExecFileSyncOptions
): { stdout: string; exitCode: 0 } {
  const stdout = execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    ...options,
  });
  return { stdout, exitCode: 0 };
}

function runFail(
  args: string[],
  options?: ExecFileSyncOptions
): { stderr: string; exitCode: number } {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      ...options,
    });
    assert.fail("Expected command to fail but it succeeded");
  } catch (error: unknown) {
    const e = error as { status: number; stderr: string };
    return { stderr: e.stderr, exitCode: e.status };
  }
}

test("--help shows usage information", () => {
  const { stdout } = run(["--help"]);
  assert.ok(stdout.includes("Usage: setup-npm-trusted-publish"));
  assert.ok(stdout.includes("--dry-run"));
  assert.ok(stdout.includes("--access"));
  assert.ok(stdout.includes("--registry"));
  assert.ok(stdout.includes("--github.repo"));
  assert.ok(stdout.includes("--gitlab.repo"));
  assert.ok(stdout.includes("--circleci.org-id"));
});

test("-h shows usage information", () => {
  const { stdout } = run(["-h"]);
  assert.ok(stdout.includes("Usage: setup-npm-trusted-publish"));
});

test("--version shows version number", () => {
  const { stdout } = run(["--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("-v shows version number", () => {
  const { stdout } = run(["-v"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("missing package name shows error", () => {
  const { stderr, exitCode } = runFail([]);
  assert.ok(stderr.includes("Package name is required"));
  assert.strictEqual(exitCode, 1);
});

test("invalid package name shows error", () => {
  const { stderr, exitCode } = runFail(["INVALID-UPPERCASE"]);
  assert.ok(stderr.includes("Invalid package name"));
  assert.strictEqual(exitCode, 1);
});

test("invalid package name with special characters shows error", () => {
  const { stderr, exitCode } = runFail(["invalid name with spaces"]);
  assert.ok(stderr.includes("Invalid package name"));
  assert.strictEqual(exitCode, 1);
});

test("invalid --mfa value shows error", () => {
  const { stderr, exitCode } = runFail(["my-package", "--mfa", "invalid"]);
  assert.ok(stderr.includes("--mfa must be one of"));
  assert.strictEqual(exitCode, 1);
});

test("--dry-run creates placeholder without publishing", () => {
  const { stdout } = run(["my-test-pkg", "--dry-run"]);
  assert.ok(stdout.includes("Creating placeholder package: my-test-pkg"));
  assert.ok(stdout.includes("Dry run mode"));
  assert.ok(stdout.includes("package created but not published"));
});

test("--dry-run with scoped package", () => {
  const { stdout } = run(["@myorg/my-test-pkg", "--dry-run"]);
  assert.ok(stdout.includes("Creating placeholder package: @myorg/my-test-pkg"));
  assert.ok(stdout.includes("Dry run mode"));
  assert.ok(stdout.includes("--access"));
});

// npm trust provider validation tests require npm >= 11.10.0
const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf-8",
  shell: true,
}).trim();
const [major = 0, minor = 0] = npmVersion.split(".").map(Number);
const hasNpmTrust = major > 11 || (major === 11 && minor >= 10);

describe("npm trust provider validation", { skip: !hasNpmTrust }, () => {
  test("github provider requires --github.file", () => {
    const { stderr, exitCode } = runFail([
      "my-package",
      "--github.repo",
      "owner/repo",
      "--dry-run",
    ]);
    assert.ok(stderr.includes("--github.repo and --github.file are required"));
    assert.strictEqual(exitCode, 1);
  });

  test("github provider requires --github.repo", () => {
    const { stderr, exitCode } = runFail([
      "my-package",
      "--github.file",
      "release.yml",
      "--dry-run",
    ]);
    assert.ok(stderr.includes("--github.repo and --github.file are required"));
    assert.strictEqual(exitCode, 1);
  });

  test("gitlab provider requires --gitlab.file", () => {
    const { stderr, exitCode } = runFail([
      "my-package",
      "--gitlab.repo",
      "owner/repo",
      "--dry-run",
    ]);
    assert.ok(stderr.includes("--gitlab.repo and --gitlab.file are required"));
    assert.strictEqual(exitCode, 1);
  });

  test("circleci provider requires all mandatory fields", () => {
    const { stderr, exitCode } = runFail([
      "my-package",
      "--circleci.org-id",
      "some-uuid",
      "--dry-run",
    ]);
    assert.ok(stderr.includes("required for CircleCI"));
    assert.strictEqual(exitCode, 1);
  });
});

test("trust mode with npm < 11.10.0 shows version error", {
  skip: hasNpmTrust,
}, () => {
  const { stderr, exitCode } = runFail([
    "my-package",
    "--github.repo",
    "owner/repo",
    "--github.file",
    "release.yml",
  ]);
  assert.ok(stderr.includes("npm trust requires npm >= 11.10.0"));
  assert.strictEqual(exitCode, 1);
});
