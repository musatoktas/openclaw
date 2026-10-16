import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { execFileUtf8 } from "./exec-file.js";
import { withServiceInspectionBudget } from "./service-inspection-budget.js";
import {
  getGatewayServiceUpdateNativeCommand as getNativeCommand,
  withGatewayServiceUpdateAuthority as withUpdateAuthority,
  withGatewayServiceInstallationRecovery as recoverInstallation,
  type GatewayServiceNativeCommand,
} from "./service-update-authority.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function nativeRunner() {
  const runner = getNativeCommand();
  if (!runner) {
    throw new Error("missing native fixture");
  }
  return runner;
}
function assertLive(current: boolean, message = "nested custody revoked") {
  if (!current) {
    throw new Error(message);
  }
}

function blockedNative() {
  const entered = createDeferred();
  const release = createDeferred();
  const commands: string[] = [];
  const state = { running: false };
  const nativeCommand: GatewayServiceNativeCommand = async (argv) => {
    state.running = true;
    commands.push(argv[0]!);
    try {
      if (argv[0] === "first") {
        entered.resolve();
        await release.promise;
      }
      return result;
    } finally {
      state.running = false;
    }
  };
  return { entered, release, commands, nativeCommand, state };
}

it("revokes a captured native runner when its service authority scope closes", async () => {
  const nativeCommand = vi.fn(async () => result);
  const captured = await withUpdateAuthority(undefined, async () => nativeRunner(), {
    nativeCommand,
  });
  await expect(captured(["unused-native"], {})).rejects.toThrow("has closed");
  expect(nativeCommand).not.toHaveBeenCalled();
});

const result = {
  stdout: "native",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};

it("expires a queued deadline without invoking it or releasing its predecessor", async () => {
  vi.useFakeTimers();
  const { entered, release, commands, nativeCommand } = blockedNative();
  let expired = false;
  try {
    const scope = withUpdateAuthority(
      () => undefined,
      async () => {
        const runner = nativeRunner();
        const first = runner(["first"], {});
        await entered.promise;
        const queued = runner(["expired"], { timeoutMs: 20 });
        const refusal = expect(queued).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(25);
        await refusal;
        expired = true;
        expect(commands).toEqual(["first"]);
        release.resolve();
        await first;
        throw new Error("fixture complete after expiry");
      },
      { nativeCommand },
    );
    await expect(scope).rejects.toThrow();
    expect(expired).toBe(true);
    expect(commands).toEqual(["first"]);
  } finally {
    release.resolve();
  }
});

it("closes unstarted submissions but joins the already running native call", async () => {
  const { entered, release, commands, nativeCommand } = blockedNative();
  let done = false;
  const work = withUpdateAuthority(
    () => undefined,
    async () => {
      const runner = nativeRunner();
      void runner(["first"], {}).catch(() => undefined);
      await entered.promise;
      void runner(["never"], {}).catch(() => undefined);
      throw new Error("initiating failure");
    },
    { nativeCommand },
  ).finally(() => {
    done = true;
  });
  const refused = expect(work).rejects.toThrow();
  await entered.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  expect(commands).toEqual(["first"]);
  release.resolve();
  await refused;
  expect(commands).toEqual(["first"]);
});

it.each(["direct", "nested", "revoked"] as const)(
  "serializes native reads before checking suspended custody: %s",
  async (scope) => {
    const { entered, release, commands, nativeCommand, state } = blockedNative();
    let current = true;
    const invoke = async () => {
      const first = execFileUtf8("first", []);
      await entered.promise;
      const second = execFileUtf8("second", []);
      expect(commands).toEqual(["first"]);
      const settled = Promise.allSettled([first, second]);
      current = scope !== "revoked";
      release.resolve();
      const outcomes = await settled;
      const expected =
        scope === "revoked" ? { status: "rejected" } : { status: "fulfilled", value: { code: 0 } };
      expect(outcomes).toMatchObject([expected, expected]);
    };
    const work = withUpdateAuthority(
      () => assertLive(!state.running, "parent is suspended"),
      () =>
        scope === "direct"
          ? invoke()
          : withUpdateAuthority(() => assertLive(current), invoke, {
              updateOwned: false,
              nativeCommand: getNativeCommand(),
            }),
      { nativeCommand },
    );
    if (scope === "revoked") {
      await expect(work).rejects.toThrow("nested custody revoked");
    } else {
      await work;
    }
    expect(commands).toEqual(scope === "revoked" ? ["first"] : ["first", "second"]);
  },
);

it.each(["settled", "thrown", "returned"] as const)(
  "compensates revoked nested custody only after native settlement: %s",
  async (kind) => {
    const commands: string[] = [];
    let current = true;
    const restore = vi.fn(async () => {
      await execFileUtf8("restore", []);
      return true;
    });
    const failure = new CommandProcessCleanupError();
    const work = withUpdateAuthority(
      () => undefined,
      () =>
        withUpdateAuthority(
          () => assertLive(current),
          () => recoverInstallation(() => execFileUtf8("publish", []), restore),
          {
            updateOwned: false,
            assertRecoveryCurrent: () => undefined,
            nativeCommand: getNativeCommand(),
          },
        ),
      {
        nativeCommand: async (argv) => {
          commands.push(argv[0]!);
          if (argv[0] === "publish") {
            current = false;
            if (kind === "thrown") {
              throw failure;
            }
            if (kind === "returned") {
              return { ...result, cleanup: "uncertain" };
            }
          }
          return result;
        },
      },
    );
    if (kind === "settled") {
      await expect(work).rejects.toMatchObject({
        code: "service-authority-revoked",
        outcome: "restored",
      });
      expect(commands).toEqual(["publish", "restore"]);
    } else {
      await expect(work).rejects.toSatisfy(hasCommandProcessCleanupError);
      expect(restore).not.toHaveBeenCalled();
      expect(commands).toEqual(["publish"]);
    }
  },
);

it("does not spend a native inspection queue's execution allowance on live custody", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const native = vi.fn<GatewayServiceNativeCommand>(async (_argv, options) => {
    expect(options.timeoutMs).toBe(100);
    now += 10;
    return result;
  });
  await withServiceInspectionBudget(async (budget) => {
    await withUpdateAuthority(
      () => {
        now += 2_000;
      },
      async () => {
        await execFileUtf8("busctl", [], { timeout: 100 });
      },
      { nativeCommand: native },
    );
    expect(budget.now()).toBe(10);
  });
  expect(native).toHaveBeenCalledOnce();
});
