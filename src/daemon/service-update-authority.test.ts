import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { execFileUtf8 } from "./exec-file.js";
import { resolveLaunchAgentPlistPath, writeLaunchAgentPlist } from "./launchd-service-files.js";
import {
  assertGatewayServiceFallbackAllowed,
  assertGatewayServiceUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand,
  readGatewayServiceUpdateOriginalRoot,
  withGatewayServiceInstallationRecovery,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

vi.mock("./launchd-system.js", () => ({ assertNoSystemLaunchDaemonOwnership: async () => {} }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function authority(message: string) {
  const owner = {
    current: true,
    assertCurrent() {
      if (!owner.current) {
        throw new Error(message);
      }
    },
  };
  return owner;
}

it("retains the live original installation through nested guards and compensation", async () => {
  const owner = authority("original updater retired");
  await withGatewayServiceUpdateAuthority(
    owner.assertCurrent,
    () =>
      withGatewayServiceUpdateAuthority(
        undefined,
        async () => {
          expect(readGatewayServiceUpdateOriginalRoot()).toBe("/original-install");
          owner.current = false;
          expect(readGatewayServiceUpdateOriginalRoot).toThrow("original updater retired");
          owner.current = true;
          await expect(
            withGatewayServiceInstallationRecovery(
              async () => {
                throw new Error("installation failed");
              },
              async () => {
                expect(readGatewayServiceUpdateOriginalRoot()).toBe("/original-install");
                return false;
              },
            ),
          ).rejects.toThrow("installation failed");
        },
        {
          originalRoot: "/replacement-install",
          updateOwned: false,
          assertRecoveryCurrent: () => {},
        },
      ),
    { originalRoot: "/original-install" },
  );
  expect(readGatewayServiceUpdateOriginalRoot()).toBeUndefined();
});

it("retains recovery material when a native writer has not settled", async () => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    cleanup: "uncertain",
  });
  const restore = vi.fn(async () => true);
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {},
      () =>
        withGatewayServiceInstallationRecovery(
          () => execFileUtf8(process.execPath, ["-e", "process.exit(0)"]),
          restore,
        ),
    ),
  ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  expect(restore).not.toHaveBeenCalled();
});

it.each([
  { revoked: false, nested: false },
  { revoked: true, nested: false },
  { revoked: false, nested: true },
  { revoked: true, nested: true },
])("native subprocess retains its owner: %j", async ({ revoked, nested }) => {
  const root = dirs.make("native-authority-");
  const effect = path.join(root, "effect");
  const owner = authority("original update owner revoked");
  const parentGroup =
    process.platform === "win32" || revoked || nested
      ? undefined
      : spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  if (parentGroup) {
    expect(parentGroup.status).toBe(0);
  }
  const run = withGatewayServiceUpdateAuthority(owner.assertCurrent, async () => {
    const invoke = async () => {
      await Promise.resolve();
      owner.current = !revoked;
      const result = await execFileUtf8(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned");
          if (${parentGroup !== undefined}) process.stdout.write(require("node:child_process").spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {encoding: "utf8"}).stdout);`,
      ]);
      expect(result.code, result.stderr).toBe(0);
      if (parentGroup) {
        expect(result.stdout.trim()).toBe(parentGroup.stdout.trim());
      }
    };
    await (nested ? withGatewayServiceUpdateAuthority(() => {}, invoke) : invoke());
  });
  if (revoked) {
    await expect(run).rejects.toThrow("original update owner revoked");
    await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await run;
    expect(await fs.readFile(effect, "utf8")).toBe("owned");
  }
});

it("Doctor compensation retains the original updater fence", async () => {
  const owner = authority("original updater retired");
  const restore = vi.fn(async () => true);
  await expect(
    withGatewayServiceUpdateAuthority(owner.assertCurrent, () =>
      withGatewayServiceUpdateAuthority(
        assertGatewayServiceUpdateCurrent,
        () =>
          withGatewayServiceInstallationRecovery(async () => {
            expect(isUpdateOwnedGatewayServiceCommand()).toBe(true);
            await Promise.resolve();
            owner.current = false;
          }, restore),
        { updateOwned: false, assertRecoveryCurrent: () => {} },
      ),
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "recovery-pending" });
  expect(restore).not.toHaveBeenCalled();
});

it("compensation closes with its callback and cannot grant an unmanaged fallback", async () => {
  const owner = authority("Doctor custody released");
  const ready = createDeferred();
  let late!: Promise<void>;
  await expect(
    withGatewayServiceUpdateAuthority(
      owner.assertCurrent,
      () =>
        withGatewayServiceInstallationRecovery(
          async () => {
            expect(isUpdateOwnedGatewayServiceCommand()).toBe(false);
            owner.current = false;
          },
          async () => {
            expect(() => assertGatewayServiceFallbackAllowed("detached launch")).toThrow(
              "not an update-owned",
            );
            late = ready.promise.then(() => {
              assertGatewayServiceUpdateCurrent();
            });
            return true;
          },
        ),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "restored" });
  ready.resolve();
  await expect(late).rejects.toThrow("has closed");
});

it("native plist publication rechecks after asynchronous preparation, without stale rollback", async () => {
  const root = dirs.make("native-plist-authority-");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.native-test",
  };
  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, "original");
  const owner = authority("original update owner revoked");
  const originalWrite = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await originalWrite(...args);
    owner.current = false;
  });
  await expect(
    withGatewayServiceUpdateAuthority(owner.assertCurrent, () =>
      writeLaunchAgentPlist({
        env,
        stdout: process.stdout,
        programArguments: [process.execPath, "gateway"],
      }),
    ),
  ).rejects.toThrow("original update owner revoked");
  expect(await fs.readFile(plistPath, "utf8")).toBe("original");
});

it.each([true, false])(
  "retained guards and async work lose authority at scope closure (update=%s)",
  async (updateOwned) => {
    const ready = createDeferred();
    let late!: Promise<void>;
    let retained!: () => void;
    await withGatewayServiceUpdateAuthority(
      undefined,
      async (assertCurrent) => {
        retained = assertCurrent;
        await Promise.resolve();
        assertCurrent();
        late = ready.promise.then(() =>
          assertGatewayServiceFallbackAllowed("late detached launch"),
        );
      },
      { updateOwned, assertRecoveryCurrent: () => {} },
    );
    expect(() => retained()).toThrow("has closed");
    ready.resolve();
    await expect(late).rejects.toThrow("has closed");
    expect(assertGatewayServiceUpdateCurrent).not.toThrow();
  },
);
