import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as runAdmission from "../../agents/admitted-run-context.js";
import * as runs from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import * as caller from "../../agents/tools/gateway-caller-context.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { isReplyRunEvidenceStale } from "../../auto-reply/reply/reply-run-registry.state.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import * as registry from "../../infra/agent-run-registry.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { startGatewayDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const session = { sessionId: "human-wait-session", sessionKey: "agent:main:main" };
const ref = { ...session, runId: "human-wait-run" };
const target = { agentId: "main", sessionKey: session.sessionKey };
const answers = () => ({ answers: { answer: ["synthetic-human-answer"] } });
let manager: QuestionManager;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let authority: registry.AgentRunDelegatedAuthority;
let unregister: () => void;
let client: GatewayClient;
let handlers: ReturnType<typeof createQuestionHandlers>;
let admission: runAdmission.PreparedAgentRunAdmission;
let onBroadcast: (event: string) => void;
let requesterActive: boolean;
let validateAuthority: ReturnType<typeof createAgentRuntimeApprovalAuthorityValidator>;
const abort = vi.fn();
let handle: runs.EmbeddedAgentQueueHandle;

function runtimeClient(claim: registry.AgentRunDelegatedAuthority): GatewayClient {
  return {
    connect: { scopes: ["operator.admin"] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        ...target,
        operationalRunInstance: claim.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...claim },
      },
    },
  } as GatewayClient;
}

function heartbeat(
  recovery = vi.fn(recoverStuckDiagnosticSession),
  options: Parameters<typeof startGatewayDiagnosticHeartbeat>[2] = {},
) {
  startGatewayDiagnosticHeartbeat(
    createTestGatewayScheduler("fake-timers"),
    {},
    {
      ...options,
      recoverStuckSession: recovery,
    },
  );
  return recovery;
}

const withState = (run: () => Promise<void>) => withOpenClawTestState({ scenario: "minimal" }, run);

function replaceOnExpiry(replacement: runs.EmbeddedAgentQueueHandle) {
  onBroadcast = (event) => {
    if (event === "question.resolved") {
      runs.setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
    }
  };
}

function replacementHandle() {
  const replacement = {
    ...handle,
    abort: vi.fn<() => void>(() =>
      runs.clearActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey),
    ),
  };
  return replacement;
}

beforeEach(async () => {
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  diagnostics.setDiagnosticsEnabledForProcess(true);
  scheduler = createTestGatewayScheduler("fake-timers");
  manager = new QuestionManager(scheduler);
  onBroadcast = () => {};
  requesterActive = true;
  const validateRunAuthority = createAgentRuntimeApprovalAuthorityValidator();
  validateAuthority = (identity) => requesterActive && validateRunAuthority(identity);
  registry.registerAgentRunContext(ref.runId, target);
  admission = runAdmission.prepareSystemAgentRunAdmission(
    {},
    ref.runId,
    "main",
    "question-recovery-test",
  );
  const admitted = await admission.admit("embedded");
  authority = runAdmission.getAdmittedRunDelegatedAuthority(admitted)!;
  unregister = registry.registerAgentRunDelegatedAuthorityClosedHandler(() =>
    manager.cancelClosedAuthorities(),
  );
  client = runtimeClient(authority);
  handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    scheduler,
  );
  abort.mockReset().mockImplementation(() => {
    registry.releaseAgentRunDelegatedAuthority(authority);
    runs.clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
  });
  await caller.withGatewayToolCallerIdentity(
    caller.createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      ...target,
    }),
    () => runs.setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey),
  );
});

afterEach(async () => {
  manager.close();
  await manager.drain();
  resetDiagnosticStateForTest();
  admission.close();
  registry.releaseAgentRunDelegatedAuthority(authority);
  unregister();
  registry.clearAgentRunContext(ref.runId);
  embeddedRunTesting.resetActiveEmbeddedRuns();
  diagnostics.resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

async function call(
  method: string,
  params: Record<string, unknown>,
  trusted = true,
  requestAuthority: Pick<GatewayRequestHandlerOptions, "signal" | "hasCurrentClientAuthority"> = {},
) {
  const responses: Parameters<RespondFn>[] = [];
  const cfg = {};
  await handlers[method]!({
    req: { type: "req", id: "request", method, params },
    params,
    client: trusted ? client : ({ connect: { scopes: ["operator.admin"] } } as GatewayClient),
    respond: (...args) => responses.push(args),
    isWebchatConnect: () => false,
    ...requestAuthority,
    context: {
      broadcast: (event: string) => onBroadcast(event),
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: validateAuthority,
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  return responses[0];
}

async function request(trusted = true, timeoutMs = 3_600_000, id = "human-question") {
  const params = {
    id,
    ...target,
    runId: ref.runId,
    timeoutMs,
    questions: [
      {
        questionId: "answer",
        header: "Input",
        question: "Provide the requested input",
        options: [],
        isOther: true,
      },
    ],
  };
  expect((await call("question.request", params, trusted))?.[0]).toBe(true);
  expect(manager.get(params.id)).toMatchObject({
    status: "pending",
    expiresAtMs: Date.now() + timeoutMs,
  });
  return params.id;
}

function startQuestionTool(toolCallId: string) {
  diagnostics.emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...ref,
    toolName: "ask_user",
    toolCallId,
  });
}

it("keeps an accepted one-hour question alive through default diagnostic recovery", async () => {
  await withState(async () => {
    const recovery = heartbeat();
    startQuestionTool("human-call");
    await vi.advanceTimersByTimeAsync(10_000);
    const id = await request();
    await vi.advanceTimersByTimeAsync(920_000);
    expect(recovery).toHaveBeenCalledWith(
      expect.objectContaining({ allowActiveAbort: true, queueDepth: 0 }),
    );
    expect([abort.mock.calls.length, manager.get(id)?.status]).toEqual([0, "pending"]);
    const answer = manager.waitAnswer(id);
    await vi.advanceTimersByTimeAsync(2_500_000);
    expect(abort).not.toHaveBeenCalled();
    expect((await call("question.resolve", { id, answers: answers() }))?.[0]).toBe(true);
    await expect(answer).resolves.toMatchObject({ status: "answered", answers: answers() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort).not.toHaveBeenCalled();
    // Resolution is real progress, but a tool that stays hung is still recovered.
    await vi.advanceTimersByTimeAsync(900_000);
    await Promise.all(recovery.mock.results.map((result) => result.value));
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

function recover() {
  return recoverStuckDiagnosticSession({
    ...ref,
    ageMs: 930_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

it("keeps a replacement alive when a heartbeat expires its pending question", async () => {
  await withState(async () => {
    const heartbeatAtMs = Date.now() + 900_000;
    const recovery = vi.fn(recoverStuckDiagnosticSession);
    const replacement = replacementHandle();
    replaceOnExpiry(replacement);
    heartbeat(recovery, {
      emitMemorySample: () => {
        if (Date.now() === heartbeatAtMs) {
          // Synchronous sampling crosses expiry before its timer can run;
          // this does not depend on equal-deadline timer ordering.
          vi.setSystemTime(heartbeatAtMs + 100);
        }
        return {
          rssBytes: 100,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          externalBytes: 10,
          arrayBuffersBytes: 5,
        };
      },
      sampleLiveness: () => null,
    });
    startQuestionTool("heartbeat-expiry-call");
    await vi.advanceTimersByTimeAsync(50);
    const id = await request(true, 900_000);
    const answer = manager.waitAnswer(id);

    await vi.advanceTimersByTimeAsync(899_950);
    await Promise.all(recovery.mock.results.map((result) => result.value));

    await expect(answer).resolves.toEqual({ status: "expired" });
    expect([abort.mock.calls, replacement.abort.mock.calls]).toEqual([[], []]);
  });
});

it("keeps resumed question work alive when attention reporting settles the question", async () => {
  await withState(async () => {
    const recovery = heartbeat(undefined, { sampleLiveness: () => null });
    startQuestionTool("reporting-settlement-call");
    const id = await request();
    const answer = manager.waitAnswer(id);
    const unsubscribe = diagnostics.onDiagnosticEvent((event) => {
      if (
        event.type === "session.stalled" &&
        event.sessionId === ref.sessionId &&
        event.sessionKey === ref.sessionKey &&
        event.ageMs === 900_000
      ) {
        // Attention events can settle a question after the heartbeat captured its generation.
        manager.cancel(id);
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(900_000);
      expect(manager.observe(id)?.record.status).toBe("cancelled");
      const outcomes = await Promise.all(recovery.mock.results.map((result) => result.value));

      await expect(answer).resolves.toEqual({ status: "cancelled" });
      expect(recovery).toHaveBeenCalledWith(
        expect.objectContaining({ allowActiveAbort: true, ageMs: 900_000 }),
      );
      expect(outcomes).toContainEqual(
        expect.objectContaining({ status: "skipped", reason: "stale_session_state" }),
      );
      expect(abort).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

it.each(["active", "signal", "current client"] as const)(
  "settles a stopped RPC observer with %s authority without expiring its question",
  async (source) => {
    const id = await request(false, 100);
    const events: string[] = [];
    onBroadcast = (event) => events.push(event);
    const observer = new AsyncWorkScope();
    const controller = new AbortController();
    let current = true;
    const registered = vi.spyOn(manager, "waitAnswer");
    const auth =
      source === "active"
        ? {}
        : {
            signal: controller.signal,
            hasCurrentClientAuthority: () => current,
          };
    const waiting = observer.track(() => call("question.waitAnswer", { id }, false, auth));
    const result = Promise.allSettled([waiting]);
    try {
      expect(registered).toHaveBeenCalledExactlyOnceWith(id, undefined, undefined);
      observer.beginClose();
      if (source === "signal") {
        controller.abort(new Error("Question request source closed"));
      } else if (source === "current client") {
        current = false;
      }
      // Cross the deadline with its timer still queued: cleanup is not a decision.
      vi.setSystemTime(Date.now() + 101);
      if (source === "active") {
        await expect(waiting).resolves.toEqual([true, { status: "pending" }, undefined]);
      } else {
        const message =
          source === "signal"
            ? "Question request source closed"
            : "Gateway requester authority changed";
        expect((await result)[0]).toMatchObject({ status: "rejected", reason: { message } });
      }
      await observer.drain();
      if (source === "active") {
        manager.close();
      } else {
        expect(manager.observe(id)?.record.status).toBe("pending");
      }
      expect(events).toEqual([]);
    } finally {
      observer.beginClose();
      if (source === "active") {
        manager.close();
      }
      await result;
      await observer.drain();
      registered.mockRestore();
    }
  },
);

it("does not let operator questions or public diagnostic text suppress unrelated run recovery", async () => {
  const id = await request(false);
  startQuestionTool(id);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect(manager.get(id)?.status).toBe("pending");
});

it("keeps explicit user abort authoritative during human input", async () => {
  const id = await request();
  await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
  await expect(
    runs.abortAndDrainEmbeddedAgentRun({ ...ref, reason: "user_abort" }),
  ).resolves.toMatchObject({
    aborted: true,
    drained: true,
  });
  expect(manager.get(id)?.status).toBe("cancelled");
});

it.each([true, false])(
  "protects late human input only for its owning reply backend (%s)",
  async (owns) => {
    const operation = createReplyOperation({ ...session, resetTriggered: false });
    if (owns) {
      operation.attachBackend(Object.assign(handle, { kind: "embedded" as const, cancel: abort }));
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => "human-wait-surface",
        project: () => "human-wait-surface",
      });
    } else {
      operation.attachBackend({ ...handle, kind: "embedded", cancel: () => {} });
    }
    operation.setPhase("running");
    try {
      await request();
      startQuestionTool(owns ? "late-answer-call" : "unrelated-call");
      await vi.advanceTimersByTimeAsync(930_000);
      expect(isReplyRunEvidenceStale(operation)).toBe(!owns);
      if (owns) {
        await expect(
          admitReplyTurn({
            ...session,
            kind: "visible",
            resetTriggered: false,
            waitForActive: false,
          }),
        ).resolves.toMatchObject({
          status: "skipped",
          reason: "active-run",
          activeOperation: operation,
        });
      }
    } finally {
      operation.complete();
    }
  },
);

it("does not transfer a pending question to a replacement handle with the same run ID", async () => {
  await request();
  const replacement = replacementHandle();
  runs.setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect([replacement.abort.mock.calls.length, abort.mock.calls.length]).toEqual([1, 0]);
});

it("refuses to bind new authority to the old handle when a run ID is reused", async () => {
  await request();
  const replacementAuthority = registry.claimAgentRunDelegatedAuthority({
    runId: ref.runId,
    instanceId: "replacement-instance",
  });
  try {
    client = runtimeClient(replacementAuthority);
    await request(true, 3_600_000, "replacement-question");
    await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  } finally {
    registry.releaseAgentRunDelegatedAuthority(replacementAuthority);
  }
});

it.each(["pending", "requester-inactive"] as const)(
  "rechecks a question accepted after recovery was queued (%s)",
  async (terminal) => {
    const { promise: gate, resolve: release } = createDeferred();
    const recovery = vi.fn(async (params: Parameters<typeof recoverStuckDiagnosticSession>[0]) => {
      await gate;
      return recoverStuckDiagnosticSession(params);
    });
    heartbeat(recovery);
    startQuestionTool("queued-call");
    await vi.advanceTimersByTimeAsync(930_000);
    expect(recovery).toHaveBeenCalledTimes(1);
    await request();
    if (terminal === "requester-inactive") {
      // Worker placement or turn capability can close while the local run claim survives.
      requesterActive = false;
      manager.cancelClosedAuthorities();
    }
    release();
    const outcome = await recovery.mock.results[0]!.value;
    if (terminal === "requester-inactive") {
      expect(outcome).toMatchObject({ status: "aborted" });
      expect(abort).toHaveBeenCalledOnce();
      return;
    }
    expect(outcome).toMatchObject({ status: "skipped", reason: "human_input_wait" });
    expect(abort).not.toHaveBeenCalled();
  },
);

it("keeps the run protected until its last pending human question settles", async () => {
  const first = await request();
  const second = await request(true, 3_600_000, "second-question");
  manager.cancel(first);
  await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });
  manager.cancel(second);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
});

it("does not abort a replacement installed synchronously by question expiry", async () => {
  await request(true, 900_000);
  const replacement = { ...handle, abort: vi.fn() };
  replaceOnExpiry(replacement);
  vi.setSystemTime(Date.now() + 900_000);
  await expect(recover()).resolves.toMatchObject({
    status: "skipped",
    reason: "stale_session_state",
  });
  expect([abort.mock.calls, replacement.abort.mock.calls]).toEqual([[], []]);
});
