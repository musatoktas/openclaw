import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as failoverErrors from "../failover-error.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  expectExactResolvedAcknowledgement,
} from "./sessions-tool.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-tool-");
type ToolOptions = NonNullable<Parameters<typeof createSessionsTool>[0]>;
const mainKey = "agent:main:main";
const visibleConfig = { tools: { sessions: { visibility: "agent" } } } satisfies OpenClawConfig;
const fixedStoreConfig = {
  session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
  agents: {
    ownership: "explicit",
    defaults: { sessionStore: { agentId: "ops" } },
    entries: { ops: {}, research: {} },
  },
} satisfies OpenClawConfig;
const makeTool = (options: ToolOptions = {}) =>
  createSessionsTool({ agentSessionKey: mainKey, config: {}, ...options });
const visibleTool = (callGateway: AgentToolGatewayRequestCaller) =>
  makeTool({ config: visibleConfig, callGateway });

function expectReceipt(
  work: ExecutionDecisionWork[],
  operation: string,
  fact = "committed",
  outcome = "allowed",
  target?: string,
) {
  expect(work[0]).toMatchObject({
    receipt: {
      action: { family: "session", operation },
      decision: { outcome, reasonCode: `session_${operation}_${fact}` },
      enforcement: { coverageState: "attribution-only" },
    },
    ...(target
      ? { refs: { target: { namespace: "session", value: `["main","${target}"]` } } }
      : {}),
  });
}

function modelFallback(prevModel = "good", ts = 1) {
  return { prevModel, prevProvider: "openai", ts, source: "agent-patch" as const };
}
const modelEntry = (model: string, provider = "openai") => ({
  model,
  modelProvider: provider,
  modelOverride: model,
  providerOverride: provider,
});

async function seedModelSession(entry: Parameters<typeof upsertSessionEntryCore>[1]) {
  const scope = {
    agentId: "main",
    sessionKey: mainKey,
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1, ...entry });
  return scope;
}

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

async function captureSessionDecisionWork<T>(run: () => Promise<T>, receiptAuthority = () => true) {
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const token = createExecutionIdentityAdmissionToken("sessions-tool-action", {
      contextId: "sessions-tool-context",
      executionId: "sessions-tool-execution",
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        executionIdentityToken: token,
        receiptAuthority,
      },
      run,
    );
    return { result, work };
  } finally {
    clear();
  }
}

it.each([
  [
    "persisted bare owner",
    { agentSessionKey: "global" },
    { label: "Ops" },
    { key: "global", agentId: "ops", label: "Ops" },
  ],
  [
    "current requester",
    { agentSessionKey: "agent:research:main", requesterAgentIdOverride: "research" },
    { sessionKey: "current", label: "Research" },
    { key: "agent:research:main", label: "Research" },
  ],
] satisfies Array<[string, ToolOptions, Record<string, unknown>, Record<string, unknown>]>)(
  "patches under the %s without resolving another owner",
  async (name, options, args, params) => {
    const callGateway = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeTool({
      ...options,
      config: fixedStoreConfig,
      callGateway,
    });
    await tool.execute(name, { action: "patch", ...args });
    expect(callGateway).toHaveBeenCalledWith({ method: "sessions.patch", params });
    expect(callGateway.mock.calls.some(([request]) => request.method === "sessions.resolve")).toBe(
      false,
    );
  },
);

it("does not treat another agent's bare global row as self for patch", async () => {
  const requests: AgentToolGatewayRequest[] = [];
  const callGateway: AgentToolGatewayRequestCaller = async <T>(
    request: AgentToolGatewayRequest,
  ) => {
    requests.push(request);
    if (request.method === "sessions.resolve") {
      return { agentId: "ops", key: "global" } as T;
    }
    throw new Error(`unexpected gateway mutation: ${request.method}`);
  };
  const tool = makeTool({
    agentSessionKey: "global",
    requesterAgentIdOverride: "research",
    config: {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
      // Narrowed visibility keeps the cross-agent denial as the observable proof
      // that the foreign bare row was resolved to its owner, not treated as self.
      tools: { sessions: { visibility: "agent" } },
    },
    callGateway,
  });

  await expect(
    tool.execute("foreign-global-patch", {
      action: "patch",
      sessionKey: "2fb701ef-6425-4c48-9b6f-5a170aa2477e",
      label: "Ops",
    }),
  ).rejects.toThrow("Session status visibility is restricted");
  expect(requests).toContainEqual(expect.objectContaining({ method: "sessions.resolve" }));
  expect(
    requests.some((request) =>
      ["sessions.patch", "sessions.reset", "sessions.delete"].includes(request.method),
    ),
  ).toBe(false);
});

it.each([
  [
    "incognito patch",
    { agentSessionKey: "agent:main:dashboard:incognito-private" },
    { action: "patch", label: "private" },
    "Session not visible from session tools",
  ],
  ["independent creation", {}, { action: "create" }, "Unknown action: create"],
  [
    "self deletion",
    {},
    { action: "delete", sessionKey: mainKey },
    "Cannot delete the session running this tool",
  ],
  ["empty patch", {}, { action: "patch" }, "Patch setting required"],
] satisfies Array<[string, ToolOptions, Record<string, unknown>, string]>)(
  "rejects %s before dispatch",
  async (name, options, args, error) => {
    const callGateway = vi.fn();
    const tool = makeTool({ ...options, callGateway });
    await expect(tool.execute(name, args)).rejects.toThrow(error);
    if (args.action === "create") {
      expect(tool.parameters).not.toHaveProperty("properties.parentSessionKey");
      expect(tool.parameters).not.toHaveProperty("properties.agentId");
      expect(tool.parameters).not.toHaveProperty("properties.fork");
    }
    expect(callGateway).not.toHaveBeenCalled();
  },
);

it.each([
  ["default transcript deletion", undefined, "finished-revision", true],
  ["explicit transcript preservation", false, undefined, false],
] as const)("archives before %s", async (_name, deleteTranscript, lifecycleRevision, deleted) => {
  const sessionKey = "agent:main:dashboard:finished";
  const sessionId = "finished-session";
  const callGateway = vi.fn(async (request: { method: string }) =>
    request.method === "sessions.patch"
      ? { ok: true, entry: { sessionId, ...(lifecycleRevision ? { lifecycleRevision } : {}) } }
      : { ok: true, deleted },
  );
  const tool = visibleTool(callGateway as never);

  const { work } = await captureSessionDecisionWork(() =>
    tool.execute("delete-session", {
      action: "delete",
      sessionKey,
      expectedSessionId: sessionId,
      ...(deleteTranscript === undefined ? {} : { deleteTranscript }),
    }),
  );

  expect(callGateway.mock.calls).toEqual([
    [
      {
        method: "sessions.patch",
        params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
      },
    ],
    [
      {
        method: "sessions.delete",
        params: {
          key: sessionKey,
          archivedOnly: true,
          expectedSessionId: sessionId,
          ...(lifecycleRevision ? { expectedLifecycleRevision: lifecycleRevision } : {}),
          deleteTranscript: deleteTranscript ?? true,
        },
      },
    ],
  ]);
  expect(work).toHaveLength(1);
  expectReceipt(work, "delete", "committed", "allowed", sessionKey);
});

it("does not discover a lifecycle identity while deleting another session", async () => {
  const callGateway = vi.fn();
  const tool = visibleTool(callGateway);

  await expect(
    tool.execute("delete-without-identity", {
      action: "delete",
      sessionKey: "agent:main:dashboard:finished",
    }),
  ).rejects.toThrow("requires a durable session identity");
  expect(callGateway).not.toHaveBeenCalled();
});

it("does not delete a session when archive cannot identify its generation", async () => {
  const sessionKey = "agent:main:dashboard:finished";
  const sessionId = "finished-session";
  const callGateway = vi.fn(async () => ({ ok: true }));
  const tool = visibleTool(callGateway as never);

  await expect(
    tool.execute("delete-missing-generation", {
      action: "delete",
      sessionKey,
      expectedSessionId: sessionId,
    }),
  ).rejects.toThrow("archive did not return its session identity");

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(callGateway).toHaveBeenCalledWith({
    method: "sessions.patch",
    params: {
      key: sessionKey,
      archived: true,
      expectedSessionId: sessionId,
    },
  });
});

it("resets another visible session through the canonical gateway method", async () => {
  const sessionKey = "agent:main:dashboard:reset-me";
  const callGateway = vi.fn(async () => ({ ok: true }));
  const tool = visibleTool(callGateway as never);

  const { work } = await captureSessionDecisionWork(() =>
    tool.execute("reset-session", { action: "reset", sessionKey }),
  );

  expect(callGateway).toHaveBeenCalledWith({
    method: "sessions.reset",
    params: {
      key: sessionKey,
      reason: "reset",
    },
  });
  expectReceipt(work, "reset");
});

it("records a committed restore result", async () => {
  gatewayMocks.callGateway.mockResolvedValue({
    ok: true,
    path: "/tmp/sessions.sqlite",
    key: "agent:main:main",
    entry: { sessionId: "session-main" },
  });
  const tool = makeTool({ agentSessionId: "session-main" });

  const { work } = await captureSessionDecisionWork(() =>
    tool.execute("committed-restore", { action: "patch", archived: false }),
  );

  expect(work).toHaveLength(1);
  expectReceipt(work, "restore");
});

it("records a typed archive conflict", async () => {
  const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
    throw new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "arbitrary presentation text",
      retryable: false,
      details: { reason: "session-changed" },
    });
  });
  const tool = makeTool({ agentSessionId: "session-main", callGateway });

  const { work } = await captureSessionDecisionWork(async () => {
    await expect(
      tool.execute("conflict-archive", { action: "patch", archived: true }),
    ).rejects.toThrow("arbitrary presentation text");
  });

  expect(work).toHaveLength(1);
  expectReceipt(work, "archive", "conflict", "denied");
});

it("drops a session result when receipt authority closes across its awaited RPC", async () => {
  let authorityActive = true;
  gatewayMocks.callGateway.mockImplementation(async () => {
    authorityActive = false;
    return {
      ok: true,
      path: "/tmp/sessions.sqlite",
      key: "agent:main:main",
      entry: { sessionId: "session-main" },
    };
  });
  const tool = makeTool();
  const { work } = await captureSessionDecisionWork(
    () => tool.execute("closed-patch", { action: "patch", label: "Updated" }),
    () => authorityActive,
  );
  expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
  expect(work).toEqual([]);
});

it("patches its session, then reverts a failed agent-selected model", async () => {
  const sessionScope = await seedModelSession({
    ...modelEntry("good"),
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "openai",
    modelOverrideFallbackOriginModel: "primary",
    authProfileOverride: "good-profile",
    authProfileOverrideSource: "user",
    thinkingLevel: "high",
  });
  const { sessionKey, storePath } = sessionScope;
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: { defaults: { model: { primary: "openai/good" } } },
  };
  const callGateway = vi.fn(
    async (request: { method: string; params: Record<string, unknown> }) => {
      expect(request.method).toBe("sessions.patch");
      expect(isAgentSessionModelPatchOrigin()).toBe(true);
      await patchSessionEntryCore(sessionScope, () => ({
        label: request.params.label as string,
        ...modelEntry("bad", "broken"),
        modelOverrideSource: "user",
        modelOverrideFallbackOriginProvider: undefined,
        modelOverrideFallbackOriginModel: undefined,
        authProfileOverride: "bad-profile",
        authProfileOverrideSource: "user",
        thinkingLevel: "low",
        modelFallback: {
          prevModel: "good",
          prevProvider: "openai",
          prevModelOverride: "good",
          prevProviderOverride: "openai",
          prevModelOverrideSource: "auto",
          prevModelOverrideFallbackOriginProvider: "openai",
          prevModelOverrideFallbackOriginModel: "primary",
          prevAuthProfileOverride: "good-profile",
          prevAuthProfileOverrideSource: "user",
          prevThinkingLevel: "high",
          ts: Date.now(),
          source: "agent-patch",
        },
      }));
      return { ok: true };
    },
  );
  const tool = makeTool({
    agentSessionKey: sessionKey,
    config: cfg,
    callGateway: callGateway as never,
  });
  const guardParams = { cfg, ...sessionScope };
  const currentRunGuard = await createAgentPatchedSessionModelRunGuard(guardParams);
  const failedCurrentRunGuard = await createAgentPatchedSessionModelRunGuard(guardParams);

  await tool.execute("patch-model", {
    action: "patch",
    label: "Research",
    model: "broken/bad",
  });

  expect(callGateway).toHaveBeenCalledWith({
    method: "sessions.patch",
    params: {
      key: sessionKey,
      label: "Research",
      model: "broken/bad",
    },
  });
  await currentRunGuard.finish(true);
  expect(loadSessionEntry(sessionScope)).toHaveProperty("modelFallback");

  const failure = { status: 404, message: "No endpoints found for broken/bad." };
  const entryBeforeFailure = loadSessionEntry(sessionScope);
  const transcriptScope = { ...sessionScope, sessionId: "session-main" };
  const transcriptBeforeFailure = await loadTranscriptEvents(transcriptScope);
  const classifyFailure = vi
    .spyOn(failoverErrors, "resolveFailoverReasonFromError")
    .mockImplementation(() => {
      throw new Error("An unarmed model-patch guard must not classify failures");
    });
  try {
    expect(failedCurrentRunGuard.captureFallbackFailure([])).toBeUndefined();
    expect(failedCurrentRunGuard.captureFailure(failure)).toBe(false);
    expect(
      failedCurrentRunGuard.captureFallbackFailure([
        { error: failure.message, reason: "model_not_found" },
      ]),
    ).toBe(false);
    await failedCurrentRunGuard.fail(failure);
    expect(classifyFailure).not.toHaveBeenCalled();
  } finally {
    classifyFailure.mockRestore();
  }
  expect(loadSessionEntry(sessionScope)).toEqual(entryBeforeFailure);
  expect(await loadTranscriptEvents(transcriptScope)).toEqual(transcriptBeforeFailure);

  const runGuard = await createAgentPatchedSessionModelRunGuard(guardParams);
  await runGuard.fail(failure);
  expect(loadSessionEntry(sessionScope)).toMatchObject({
    model: "good",
    modelProvider: "openai",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "openai",
    modelOverrideFallbackOriginModel: "primary",
    authProfileOverride: "good-profile",
    thinkingLevel: "high",
  });
  expect(loadSessionEntry(sessionScope)).not.toHaveProperty("modelFallback");
  const messages = (await loadTranscriptEvents(transcriptScope)).map((event) => event.message);
  expect(messages).toContainEqual(
    expect.objectContaining({
      customType: "openclaw.system-note",
      content: "System note: model broken/bad failed; reverted to openai/good.",
    }),
  );
  expect(messages).not.toContainEqual(
    expect.objectContaining({
      customType: "openclaw.system-note",
      excludeFromContext: expect.anything(),
    }),
  );
});

it("clears the model fallback marker after a successful run", async () => {
  const scope = await seedModelSession({ modelFallback: modelFallback() });
  const guard = await createAgentPatchedSessionModelRunGuard({ cfg: {}, ...scope });
  await guard.finish(true);
  expect(loadSessionEntry(scope)).not.toHaveProperty("modelFallback");
});

it("denies model patches without in-process gateway context", async () => {
  const callGateway = vi.fn();
  const tool = makeTool({
    callGateway,
    hasInProcessGatewayContext: () => false,
  });

  const result = await tool.execute("patch-model", {
    action: "patch",
    model: "openai/gpt-5.4",
  });

  expect(result.details).toEqual({
    status: "forbidden",
    error: "Model patch needs in-process gateway.",
  });
  expect(callGateway).not.toHaveBeenCalled();
});

it("reverts when the patched model fails but a fallback completes the run", async () => {
  const scope = await seedModelSession({
    ...modelEntry("bad", "broken"),
    modelFallback: modelFallback(),
  });
  const runGuard = await createAgentPatchedSessionModelRunGuard({ cfg: {}, ...scope });

  const needsRevert = runGuard.captureFallbackFailure([
    {
      error: "No endpoints found for broken/bad.",
      reason: "model_not_found",
    },
    { error: "Fallback context overflow.", reason: "context_overflow" },
  ]);
  await runGuard.finish(!needsRevert);

  expect(loadSessionEntry(scope)).toMatchObject({
    model: "good",
    modelProvider: "openai",
  });
  expect(loadSessionEntry(scope)).not.toHaveProperty("modelFallback");
});

it("promotes the newest validated model across overlapping patches", async () => {
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: { primary: "openai/a" } } },
  };
  const scope = await seedModelSession({
    ...modelEntry("b"),
    modelFallback: modelFallback("a", 10),
  });
  const runB = await createAgentPatchedSessionModelRunGuard({ cfg, ...scope });
  await patchSessionEntryCore(scope, () => ({
    model: "c",
    modelOverride: "c",
    modelFallback: modelFallback("a", 20),
  }));
  const runC = await createAgentPatchedSessionModelRunGuard({ cfg, ...scope });
  await patchSessionEntryCore(scope, () => ({
    model: "d",
    modelOverride: "d",
    modelFallback: modelFallback("a", 30),
  }));
  const runD = await createAgentPatchedSessionModelRunGuard({ cfg, ...scope });

  await runC.finish(true);
  await runB.finish(true);
  expect(loadSessionEntry(scope)?.modelFallback).toMatchObject({
    prevModel: "c",
    prevProvider: "openai",
    lastValidatedPatchTs: 20,
    ts: 30,
  });

  await runD.fail({ status: 404, message: "No endpoints found for openai/d." });
  expect(loadSessionEntry(scope)).toMatchObject({
    model: "c",
    modelProvider: "openai",
    modelOverride: "c",
    providerOverride: "openai",
  });
});

it("keeps resolved model and thinking metadata when self-archive is deferred", async () => {
  const dir = sessionDirs.make();
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = "agent:main:subagent:archive-me";
  const sessionId = "archive-me-session";
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, updatedAt: 1 },
  );
  const callGateway = vi.fn(async () => ({
    ok: true as const,
    path: storePath,
    key: sessionKey,
    entry: { skillsSnapshot: "s".repeat(47_469) },
    resolved: adversarialResolved,
  }));
  const tool = makeTool({
    agentSessionKey: sessionKey,
    agentSessionId: sessionId,
    config: { session: { store: storePath } },
    callGateway: callGateway as never,
  });
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
  });

  try {
    const { result, work } = await captureSessionDecisionWork(() =>
      admission.run(() =>
        tool.execute("patch-model-thinking-archive", {
          action: "patch",
          archived: true,
          model: "openai/luna",
          thinkingLevel: "med",
        }),
      ),
    );
    expect(result.details).toEqual({
      status: "scheduled",
      sessionKey,
      message: "Session will be archived after the current agent run finishes.",
      resolved: adversarialResolved,
    });
    expectExactResolvedAcknowledgement(result, adversarialResolved);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(work).toHaveLength(1);
    expectReceipt(work, "archive", "scheduled", "allowed", sessionKey);
  } finally {
    admission.release();
  }

  await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(2));
  expect(callGateway).toHaveBeenNthCalledWith(1, {
    method: "sessions.patch",
    params: {
      key: sessionKey,
      model: "openai/luna",
      thinkingLevel: "med",
      expectedSessionId: sessionId,
    },
  });
  expect(callGateway).toHaveBeenNthCalledWith(2, {
    method: "sessions.patch",
    params: {
      key: sessionKey,
      archived: true,
      expectedSessionId: sessionId,
    },
  });
});

it.each([undefined, "tree"] as const)(
  "applies %s visibility when a non-main session categorizes a sibling",
  async (visibility) => {
    const callGateway = vi.fn(async () => ({ sessions: [] }));
    const tool = makeTool({
      agentSessionKey: "agent:main:cron:organize",
      config: { tools: { sessions: { visibility } } },
      callGateway: callGateway as never,
    });
    const patch = tool.execute("patch-other", {
      action: "patch",
      sessionKey: "agent:main:other",
      group: "Projects",
    });
    if (visibility === "tree") {
      await expect(patch).rejects.toThrow("Session status visibility is restricted");
      expect(callGateway).not.toHaveBeenCalledWith({
        method: "sessions.patch",
        params: expect.objectContaining({ key: "agent:main:other" }),
      });
    } else {
      await patch;
      expect(callGateway).toHaveBeenCalledWith({
        method: "sessions.patch",
        params: { key: "agent:main:other", category: "Projects" },
      });
    }
  },
);
