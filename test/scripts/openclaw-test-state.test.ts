import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/lib/openclaw-test-state.mts");

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cleanupTestStateHomeTrap(): string {
  return [
    'cleanup_openclaw_test_state_home() { [ -z "${OPENCLAW_TEST_STATE_HOME:-}" ] || rm -rf "$OPENCLAW_TEST_STATE_HOME"; }',
    "trap cleanup_openclaw_test_state_home EXIT",
  ].join("; ");
}

async function runState(...args: string[]) {
  return execFileAsync(process.execPath, [scriptPath, ...args]);
}

async function probeState(snippetFile: string, tmpDir?: string, after = "") {
  const setup = tmpDir ? `export OPENCLAW_TEST_STATE_TMPDIR=${shellQuote(tmpDir)};` : "";
  const { stdout } = await execFileAsync("bash", [
    "-lc",
    `${cleanupTestStateHomeTrap()}; ${setup} source ${shellQuote(snippetFile)}; ${after} node -e 'const fs=require("node:fs"); const env=process.env; const config=JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:env.HOME,stateDir:env.OPENCLAW_STATE_DIR,workspace:env.OPENCLAW_TEST_WORKSPACE_DIR,openclawHome:env.OPENCLAW_HOME,tmpDir:env.OPENCLAW_TEST_STATE_TMPDIR,tmpRoot:env.OPENCLAW_TEST_STATE_TMP_ROOT,agentDir:env.OPENCLAW_AGENT_DIR || null,channel:config.update?.channel,config}));'`,
  ]);
  return JSON.parse(stdout);
}

describe("scripts/lib/openclaw-test-state", () => {
  it("creates a sourceable env file and JSON description", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-script-"));
    const envFile = path.join(tempRoot, "env.sh");
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        scriptPath,
        "--",
        "create",
        "--label",
        "script-test",
        "--scenario",
        "update-stable",
        "--env-file",
        envFile,
        "--json",
      ]);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ label: "script-test", scenario: "update-stable" });
      for (const field of ["root", "home", "stateDir", "configPath", "workspaceDir"] as const) {
        expect(typeof payload[field]).toBe("string");
        expect(payload[field].length).toBeGreaterThan(0);
      }
      expect(payload.home).toBe(path.join(payload.root, "home"));
      expect(payload.stateDir).toBe(path.join(payload.home, ".openclaw"));
      expect(payload.configPath).toBe(path.join(payload.stateDir, "openclaw.json"));
      expect(payload.workspaceDir).toBe(path.join(payload.home, "workspace"));
      expect(payload.env).toEqual({
        HOME: payload.home,
        USERPROFILE: payload.home,
        OPENCLAW_HOME: payload.home,
        OPENCLAW_STATE_DIR: payload.stateDir,
        OPENCLAW_CONFIG_PATH: payload.configPath,
      });
      expect(payload.config).toEqual({ update: { channel: "stable" }, plugins: {} });

      const envFileText = await fs.readFile(envFile, "utf8");
      for (const key of ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
        expect(envFileText).toContain(`export ${key}=`);
      }

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(envFile)}; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,stateDir:process.env.OPENCLAW_STATE_DIR,channel:config.update.channel}));'`,
      ]);
      expect(JSON.parse(probe.stdout)).toEqual({
        home: payload.home,
        stateDir: payload.stateDir,
        channel: "stable",
      });
      await fs.rm(payload.root, { recursive: true, force: true });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders a Docker-friendly shell snippet", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-shell-"));
    const snippetFile = path.join(tempRoot, "state.sh");
    try {
      const { stdout } = await runState(
        "shell",
        "--label",
        "update-channel-switch",
        "--scenario",
        "update-stable",
      );
      expect(stdout).toContain(
        'OPENCLAW_TEST_STATE_TMP_ROOT="${OPENCLAW_TEST_STATE_TMPDIR:-${TMPDIR:-/tmp}}"',
      );
      expect(stdout).toContain(
        'mktemp -d "$OPENCLAW_TEST_STATE_TMP_ROOT/openclaw-update-channel-switch-update-stable-home.XXXXXX"',
      );
      expect(stdout).toContain("OPENCLAW_TEST_STATE_JSON");
      expect(stdout).toContain('"channel": "stable"');
      await fs.writeFile(snippetFile, stdout, "utf8");

      const payload = await probeState(snippetFile);
      expect(payload.home.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(payload.home)).toMatch(
        /^openclaw-update-channel-switch-update-stable-home\./u,
      );
      expect(payload.openclawHome).toBe(payload.home);
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.channel).toBe("stable");

      const customTemp = path.join(tempRoot, "state-tmp");
      for (const tmpDir of [customTemp, `${customTemp}/`]) {
        const customPayload = await probeState(snippetFile, tmpDir);
        expect(customPayload.tmpRoot).toBe(customTemp);
        expect(customPayload.home).toMatch(
          new RegExp(
            `^${escapeRegex(customTemp)}/openclaw-update-channel-switch-update-stable-home\\.`,
          ),
        );
        if (tmpDir.endsWith("/")) {
          expect(customPayload.stateDir).toBe(`${customPayload.home}/.openclaw`);
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates the upgrade survivor scenario", async () => {
    const { stdout } = await runState(
      "--",
      "create",
      "--label",
      "upgrade-survivor",
      "--scenario",
      "upgrade-survivor",
      "--json",
    );
    const payload = JSON.parse(stdout);
    try {
      expect(payload.scenario).toBe("upgrade-survivor");
      expect(payload.config.update).toStrictEqual({ channel: "stable" });
      expect(payload.config.gateway.reload).toStrictEqual({ mode: "off" });
      expect(payload.config.gateway.auth).toStrictEqual({
        mode: "token",
        token: { id: "GATEWAY_AUTH_TOKEN_REF", provider: "default", source: "env" },
      });
      expect(payload.config.channels.discord.enabled).toBe(true);
      expect(payload.config.channels.discord.dm).toStrictEqual({
        allowFrom: ["111111111111111111"],
        policy: "allowlist",
      });
      expect(payload.config.channels.telegram.enabled).toBe(true);
      expect(payload.config.channels.whatsapp.enabled).toBe(true);
      const renderedFunction = await runState("shell-function");
      const snippetFile = path.join(payload.root, "state-function.sh");
      await fs.writeFile(snippetFile, renderedFunction.stdout, "utf8");
      const shellHome = path.join(payload.root, "shell-home");
      const shellProbe = await execFileAsync("bash", [
        "-c",
        `source ${shellQuote(snippetFile)}; openclaw_test_state_create ${shellQuote(shellHome)} upgrade-survivor; cat "$OPENCLAW_CONFIG_PATH"`,
      ]);
      expect(JSON.parse(shellProbe.stdout).gateway).toStrictEqual(payload.config.gateway);
    } finally {
      await fs.rm(payload.root, { recursive: true, force: true });
    }
  });

  it("renders a reusable Docker shell function", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-function-"));
    const snippetFile = path.join(tempRoot, "state-function.sh");
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        scriptPath,
        "shell-function",
      ]);
      expect(stdout).toContain("openclaw_test_state_create()");
      expect(stdout).toContain("unset OPENCLAW_AGENT_DIR");
      expect(stdout).toContain("update-stable");
      await fs.writeFile(snippetFile, stdout, "utf8");

      const payload = await probeState(
        snippetFile,
        path.join(tempRoot, "function-tmp"),
        'export OPENCLAW_AGENT_DIR=/tmp/outside-agent; openclaw_test_state_create "onboard case" minimal;',
      );
      expect(payload.home).toBe(`${payload.tmpDir}/${path.basename(payload.home)}`);
      expect(payload.home).toContain("/openclaw-onboard-case-minimal-home.");
      expect(payload.agentDir).toBeNull();
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.config).toStrictEqual({});

      const trailingTmpDir = path.join(tempRoot, "function-trailing-tmp");
      const trailingPayload = await probeState(
        snippetFile,
        `${trailingTmpDir}/`,
        'openclaw_test_state_create "onboard case" minimal;',
      );
      expect(trailingPayload.home).toBe(`${trailingTmpDir}/${path.basename(trailingPayload.home)}`);
      expect(trailingPayload.stateDir).toBe(`${trailingPayload.home}/.openclaw`);
      expect(trailingPayload.workspace).toBe(`${trailingPayload.home}/workspace`);

      const existingHome = path.join(tempRoot, "existing-home");
      const existingProbe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; openclaw_test_state_create ${shellQuote(existingHome)} minimal; printf '{"kept":true}\\n' > "$OPENCLAW_CONFIG_PATH"; openclaw_test_state_create ${shellQuote(existingHome)} empty; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,config}));'`,
      ]);

      const existingPayload = JSON.parse(existingProbe.stdout);
      expect(existingPayload.home).toBe(existingHome);
      expect(existingPayload.config).toEqual({ kept: true });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
