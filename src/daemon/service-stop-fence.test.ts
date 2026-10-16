import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as openClawTmp from "../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import {
  heldServiceLockCoordinate,
  seedRetainedBorrower,
} from "../infra/update-retained-custody.test-support.js";
import * as serviceExec from "./exec-file.js";
import * as launchdCurrent from "./launchd-current-service.js";
import * as launchctl from "./launchd-exec.js";
import { stopLaunchAgent } from "./launchd-stop.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "./schtasks-control.js";
import * as schtasksExec from "./schtasks-exec.js";
import { terminateGatewayProcessTree } from "./schtasks-process.js";
import { stopSystemdService } from "./systemd-lifecycle.js";
import * as systemdScope from "./systemd-scope.js";
import * as systemdTransport from "./systemd-user-transport.js";

const native = vi.hoisted(() => ({ active: true, now: 0 }));
vi.mock("../utils.js", async (actual) => ({
  ...(await actual<typeof import("../utils.js")>()),
  sleep: async (ms: number) => {
    native.now += ms;
    native.active = false;
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  native.active = true;
  native.now = 0;
});
const assertCurrent = () => {
  if (!native.active) {
    throw new Error("stop owner retired");
  }
};
const emptyResult = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };
const taskResult = { code: 0, stdout: "<Settings><Enabled>true</Enabled></Settings>", stderr: "" };
function expectRetired(operation: Promise<unknown>) {
  return expect(operation).rejects.toThrow("stop owner retired");
}
function retire<T>(value: T) {
  native.active = false;
  return value;
}
const stopArgs = () => ({ env: {}, stdout: new PassThrough(), assertCurrent });

it("fences systemd stop after routing", async () => {
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockImplementation(async () =>
    retire({ scope: "user" as const, unitName: "test.service", unitPath: "/unit" }),
  );
  vi.spyOn(systemdTransport, "resolveSystemdUserTransport").mockResolvedValue(undefined);
  const dispatch = vi.spyOn(serviceExec, "execFileUtf8").mockResolvedValue(emptyResult);
  await expectRetired(stopSystemdService(stopArgs()));
  expect(dispatch).not.toHaveBeenCalled();
});
it("fences launchd bootout after ancestry inspection", async () => {
  vi.spyOn(launchdCurrent, "isCurrentProcessInsideLaunchdService").mockImplementation(async () =>
    retire(false),
  );
  const dispatch = vi.spyOn(launchctl, "execLaunchctl").mockResolvedValue(emptyResult);
  await expectRetired(stopLaunchAgent(stopArgs()));
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not force a Windows process tree after losing the owner during graceful drain", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(Date, "now").mockImplementation(() => native.now);
  const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((command) => {
    const stdout = command.toLowerCase().endsWith("tasklist.exe") ? '"node.exe","4242",' : "";
    return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  });
  syncBuiltinESMExports();
  await expectRetired(terminateGatewayProcessTree(4242, assertCurrent));
  expect(
    spawn.mock.calls
      .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
      .map(([, args]) => args),
  ).toEqual([["/T", "/PID", "4242"]]);
});

it("rechecks ownership after the asynchronous Windows suppression guard", async () => {
  const dispatch = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(taskResult);
  await expectRetired(
    suspendScheduledTaskAutoStartForUpdate(
      { HOME: "/unused", OPENCLAW_WINDOWS_TASK_NAME: "Native Fence Proof" },
      {
        restoreOnFailure: false,
        beforeMutation: async () => {
          assertCurrent();
          queueMicrotask(() => retire(false));
        },
        assertCurrent,
      },
    ),
  );
  expect(dispatch.mock.calls.map(([args]) => args[0])).toEqual(["/Query"]);
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["suppress", "restore"] as const)(
  "refuses task %s when retained native custody appears during its guard",
  async (operation) => {
    const root = dirs.make("task-native-custody-");
    vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    const store = createManagedHandoffLeaseStore();
    const acquired = store.acquire(root, "run", { kind: "update" });
    if (acquired.kind !== "acquired") {
      throw new Error("Expected an independent fixture executor");
    }
    const dispatch = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(taskResult);
    const beforeMutation = async () => {
      await Promise.resolve();
      seedRetainedBorrower(
        path.join(root, "managed-update-handoffs.sqlite"),
        acquired.lease,
        {
          runId: "run",
          transactionId: "transaction",
          claimId: "claim",
          revision: 1,
          recordSha256: "a".repeat(64),
          lifetimeId: "lifetime",
          serviceKey: heldServiceLockCoordinate(root),
          configPaths: [path.join(root, "config.json")],
        },
        "reserved",
      );
    };
    const change =
      operation === "suppress"
        ? suspendScheduledTaskAutoStartForUpdate
        : resumeScheduledTaskAutoStartAfterUpdate;
    await expect(
      change(
        { HOME: root, OPENCLAW_WINDOWS_TASK_NAME: "Native Custody Proof" },
        { beforeMutation },
      ),
    ).rejects.toThrow();
    expect(dispatch.mock.calls.map(([args]) => args[0])).toEqual(
      operation === "suppress" ? ["/Query"] : [],
    );
    expect(store.read(root)).toMatchObject({ kind: "current", lease: { version: 3 } });
    expect(store.release(acquired.lease)).toBe(false);
  },
);
