import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { canReceivePreparedSessionEvent } from "../session-sharing.test-utils.js";
import {
  broadcast,
  callQuestionRpc,
  createProjectedQuestionBroadcaster,
  createQuestionSource,
  createQuestionRuntimeClient,
  createQuestionPeer,
  observeQuestionWait,
  questionNotFound,
  questionOk as ok,
  questionError as errorReply,
  installQuestionTestHooks,
  manager,
  requestParams,
  secretRequestParams,
  secretRequestQuestion,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();
afterEach(resetGatewayWorkAdmission);

const answers = { answers: { destination: ["Library"] } };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

function questionPeer(
  profile: ReturnType<typeof ensureProfileForEmail>,
  connId: string,
  scopes = ["operator.sessions.write"],
) {
  const { ws: client, socket } = createQuestionPeer(
    {
      connect: { role: "operator", scopes } as GatewayWsClient["connect"],
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        avatarRevision: "",
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      },
    },
    connId,
    vi.fn(
      (
        _wire: string | Buffer,
        options?: { binary: false } | ((error?: Error) => void),
        callback?: (error?: Error) => void,
      ) => (typeof options === "function" ? options : callback)?.(),
    ),
  );
  prepareGatewayRecipientProfile(client);
  return { client, socket };
}

async function createOwnRunFixture() {
  const profile = ensureProfileForEmail("guest@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.sessions.write", "operator.sessions.read"],
          },
          suspended: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  const entry: SessionEntry = {
    sessionId: "guest-question-session",
    lifecycleRevision: "guest-question-generation",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: profile.id },
  };
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(sessionScope, entry);
  const browser = questionPeer(profile, "original-browser");
  const { source, controller: sourceController } = await createQuestionSource(browser.client, cfg);
  const authority = claimAgentRunDelegatedAuthority(
    { instanceId: "guest-question-run", runId: requestParams.runId },
    source.authority.assertCurrent,
  );
  const synthetic = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: profile.id },
    operatorRunAuthority: source.authority,
    scopes: ["operator.sessions.write"],
  });
  const runtime = createQuestionRuntimeClient(authority, requestParams, synthetic);
  const projection = await createSessionRowProjection({ cfg });
  await projection.ensureMaterialized();
  const clients = new GatewayClientRegistry([browser.client]);
  const broadcaster = createProjectedQuestionBroadcaster(cfg, projection, clients);
  broadcast.mockImplementation(broadcaster.broadcast);
  const call = (
    method: string,
    params: Record<string, unknown>,
    client: GatewayClient = browser.client,
    current?: () => boolean,
  ) =>
    callQuestionRpc(`question.${method}`, params, {
      cfg,
      client,
      registered: true,
      hasCurrentClientAuthority: current,
    });
  const request = async () => {
    const response = await call("request", requestParams, runtime);
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    return (response[1] as { id: string }).id;
  };
  const beginWait = async (
    id: string,
    client: GatewayClient = browser.client,
    hasCurrentClientAuthority?: () => boolean,
  ) => {
    const { entered, spy: observer } = observeQuestionWait();
    const result = call("waitAnswer", { id }, client, hasCurrentClientAuthority);
    try {
      await Promise.race([
        entered,
        result.then((response) => {
          throw new Error("question waiter was not admitted: " + JSON.stringify(response[2]));
        }),
      ]);
    } finally {
      observer.mockRestore();
    }
    return { result };
  };
  return {
    profile,
    cfg,
    entry,
    browser,
    runtime,
    clients,
    broadcaster,
    authority,
    source,
    revokeSource: () => sourceController.abort(new Error("Original question source revoked")),
    call,
    request,
    beginWait,
    close: async () => {
      try {
        manager.reset();
        await manager.drain();
        releaseAgentRunDelegatedAuthority(authority);
        source.release();
      } finally {
        projection.dispose();
      }
    },
  };
}

async function withOwnRunQuestion(
  run: (fixture: Awaited<ReturnType<typeof createOwnRunFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createOwnRunFixture();
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}

it.each(["suspension", "restart drain"] as const)(
  "rejects foreign question roots during %s",
  async (mode) => {
    await withOwnRunQuestion(async (f) => {
      const id = await f.request();
      const foreign = questionPeer(ensureProfileForEmail("foreign-drain@example.test"), "foreign");
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const read = vi.spyOn(manager, "get");
      const suspension =
        mode === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : undefined;
      if (mode === "suspension") {
        expect(suspension?.drain()).toBe(true);
      } else {
        markGatewayRestartDraining();
      }
      try {
        for (const method of ["get", "resolve"]) {
          expect(
            await f.call(
              method,
              { id, ...(method === "resolve" ? { answers } : {}) },
              foreign.client,
            ),
          ).toMatchObject(errorReply({ code: "UNAVAILABLE" }));
          await expect(
            f.call(
              method,
              { id, ...(method === "resolve" ? { answers } : {}) },
              f.browser.client,
              () => false,
            ),
          ).rejects.toThrow("Gateway requester authority changed");
        }
        expect(
          read,
          "foreign or revoked requests must be rejected before liveness is read",
        ).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        expect(await f.call("get", { id })).toMatchObject(
          ok({ question: { id, status: "pending" } }),
        );
        expect(await f.call("resolve", { id, answers })).toEqual(
          ok({ status: "answered", answers }),
        );
        await manager.drain();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        read.mockRestore();
        suspension?.release();
      }
    });
  },
);

it("reconnects and retains accepted answers after run close", () =>
  withOwnRunQuestion(async (f) => {
    const id = await f.request();
    expect(f.browser.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(f.browser.socket.send.mock.calls[0]![0]))).toMatchObject({
      event: "question.requested",
      payload: { id },
    });
    f.clients.delete(f.browser.client);
    const reconnected = questionPeer(f.profile, "reconnected-browser");
    f.clients.add(reconnected.client);
    expect((await f.call("list", {}, reconnected.client))[1]).toMatchObject({
      questions: [{ id }],
    });
    expect((await f.call("get", { id }, reconnected.client))[1]).toMatchObject({
      question: { id, status: "pending" },
    });
    const waiting = await f.beginWait(id, reconnected.client);
    broadcast.mockImplementation((event, payload, opts) => {
      f.broadcaster.broadcast(event, payload, opts);
      if (event === "question.resolved") {
        releaseAgentRunDelegatedAuthority(f.authority);
        f.source.release();
      }
    });
    const accepted = { status: "answered", answers };
    expect((await f.call("resolve", { id, answers }, reconnected.client))[1]).toEqual(accepted);
    expect((await waiting.result)[1]).toEqual(accepted);
    expect((await f.call("waitAnswer", { id }, reconnected.client))[1]).toEqual(accepted);
    expect((await f.call("get", { id }, reconnected.client))[1]).toMatchObject({
      question: { id, ...accepted },
    });
    await manager.drain();
    expect(reconnected.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(reconnected.socket.send.mock.calls[0]![0]))).toMatchObject({
      event: "question.resolved",
      payload: { id, ...accepted },
    });
    for (const [method, scope] of [
      ["exec.approval.resolve", "operator.approvals"],
      ["secrets.store.set", "operator.admin"],
    ] as const) {
      expect(
        await callQuestionRpc(
          method,
          {},
          {
            cfg: f.cfg,
            client: reconnected.client,
            registered: true,
          },
        ),
      ).toMatchObject(errorReply({ code: "FORBIDDEN", message: "missing scope: " + scope }));
    }
  }));

it("conceals questions from foreign viewers and members with read/write scopes", () =>
  withOwnRunQuestion(async (f) => {
    const peers = ["viewer", "member"].map((name) =>
      questionPeer(ensureProfileForEmail(name + "@example.test"), name, [
        "operator.sessions.write",
        "operator.sessions.read",
      ]),
    );
    await addSessionMember(sessionScope, {
      identityId: peers[1]!.client.authenticatedUserProfile!.profileId,
      addedBy: f.profile.id,
      expectedSessionId: f.entry.sessionId,
    });
    for (const peer of peers) {
      f.clients.add(peer.client);
      expect(
        await canReceivePreparedSessionEvent({
          cfg: f.cfg,
          client: peer.client,
          sessionKeys: [requestParams.sessionKey],
        }),
      ).toBe(true);
    }
    const id = await f.request();
    const binding = manager.observe(id)!.sessionAccess!;
    const reads = [
      vi.spyOn(binding, "assertSourceCurrent"),
      vi.spyOn(binding, "assertCurrent"),
      vi.spyOn(projectionLane.pool, "run"),
    ];
    const clearReads = () => reads.forEach((spy) => spy.mockClear());
    const expectUnread = () => expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    const requestedEvent = broadcast.mock.calls[0];
    if (!requestedEvent || requestedEvent[0] !== "question.requested") {
      throw new Error("expected the registered question event");
    }
    f.clients.delete(f.browser.client);
    clearReads();
    f.broadcaster.broadcast(...requestedEvent);
    expectUnread();
    f.clients.add(f.browser.client);
    const unrelated = claimAgentRunDelegatedAuthority({
      instanceId: "unrelated-run",
      runId: "unrelated-run",
    });
    clearReads();
    releaseAgentRunDelegatedAuthority(unrelated);
    expectUnread();
    clearReads();
    manager.cancelClosedAuthorities({ instanceId: "older-instance", runId: requestParams.runId });
    expectUnread();
    manager.cancelClosedAuthorities({ runId: "unrelated-worker-run" });
    expectUnread();
    for (const peer of peers) {
      clearReads();
      expect((await f.call("list", {}, peer.client))[1]).toEqual({ questions: [] });
      expectUnread();
      for (const method of ["get", "waitAnswer", "resolve"]) {
        clearReads();
        expect(
          await f.call(method, { id, ...(method === "resolve" ? { answers } : {}) }, peer.client),
        ).toMatchObject(questionNotFound);
        expectUnread();
      }
    }
    expect(await f.call("resolve", { id, answers })).toEqual(ok({ status: "answered", answers }));
    for (const peer of peers) {
      expect(peer.socket.send).not.toHaveBeenCalled();
    }
    await manager.drain();
  }));

it("rejects forged admission and conceals unbound, sessionless, and secret records", () =>
  withOwnRunQuestion(async (f) => {
    const unboundRuntime: GatewayClient = {
      ...f.runtime,
      internal: { agentRuntimeIdentity: f.runtime.internal?.agentRuntimeIdentity },
    };
    for (const [params, client] of [
      [requestParams, f.browser.client],
      [{ questions: requestParams.questions }, f.browser.client],
      [requestParams, unboundRuntime],
      [secretRequestParams, f.runtime],
      [
        { ...requestParams, questions: [{ ...requestParams.questions[0]!, isSecret: true }] },
        f.runtime,
      ],
    ] as const) {
      expect((await f.call("request", params, client))[0]).toBe(false);
    }
    expect(manager.list()).toEqual([]);
    const protectedRecords = [
      manager.request({ ...requestParams, id: "administrative-question" }),
      manager.request({
        id: "sessionless-question",
        questions: requestParams.questions,
        timeoutMs: 100,
      }),
      manager.request({
        ...requestParams,
        id: "secret-question",
        questions: [secretRequestQuestion],
      }),
    ];
    expect((await f.call("list", {}))[1]).toEqual({ questions: [] });
    for (const record of protectedRecords) {
      f.broadcaster.broadcast("question.requested", record);
      for (const method of ["get", "waitAnswer", "resolve"]) {
        expect(
          await f.call(method, {
            id: record.id,
            ...(method === "resolve" ? { cancel: true } : {}),
          }),
        ).toMatchObject(questionNotFound);
      }
      expect(manager.get(record.id)?.status).toBe("pending");
    }
    expect(f.browser.socket.send).not.toHaveBeenCalled();
  }));

it.each(["source revoked", "exact run closed"] as const)("settles questions when %s", (cause) =>
  withOwnRunQuestion(async (f) => {
    const id = await f.request();
    const waiting = await f.beginWait(id);
    if (cause === "source revoked") {
      setUserProfileRole(f.profile.id, "suspended");
      invalidateOperatorRolePolicy(f.profile.id);
    } else {
      releaseAgentRunDelegatedAuthority(f.authority);
    }
    const system = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: ["operator.questions"],
    });
    expect((await f.call("get", { id }, system))[1]).toMatchObject({
      question: { id, status: "cancelled" },
    });
    const response = await waiting.result;
    if (cause === "source revoked") {
      expect(response[0]).toBe(false);
    } else {
      expect(response).toEqual(ok({ status: "cancelled" }));
    }
    expect((await f.call("resolve", { id, answers }))[0]).toBe(false);
    expect(manager.get(id)).not.toHaveProperty("answers");
  }),
);

it.each(["source revocation", "transient worker failure"] as const)(
  "preserves authority outcomes across %s during reads",
  (cause) =>
    withOwnRunQuestion(async (f) => {
      const id = await f.request();
      const observation = manager.observe(id)!;
      let settled = false;
      const waiting = manager.waitAnswer(id).then((result) => {
        settled = true;
        return result;
      });
      const recipient = questionPeer(f.profile, "independent-current-recipient");
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new Error("Transient question worker read failure");
      // The injected failure must exercise the worker instead of a warm entry receipt.
      sessionChanges.invalidate({
        ...sessionScope,
        storePath: resolveOpenClawAgentSqlitePath(sessionScope),
        factsInvalidated: true,
      });
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      const spy = vi.spyOn(projectionLane.pool, "run").mockImplementationOnce(async (...args) => {
        if (cause === "transient worker failure") {
          throw failure;
        }
        const result = await run(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
      const request = f.call(
        "get",
        { id },
        cause === "source revocation" ? recipient.client : f.browser.client,
      );
      const result = Promise.allSettled([request]);
      try {
        if (cause === "transient worker failure") {
          await expect(request).rejects.toThrow(failure);
          expect(observation.isCurrent()).toBe(true);
          expect(observation.record.status).toBe("pending");
          expect(settled).toBe(false);
        } else {
          await entered.promise;
          f.revokeSource();
          expect(recipient.client.invalidated).not.toBe(true);
          expect(observation.record.status).toBe("pending");
          release.resolve();
          expect(await request).toMatchObject(questionNotFound);
          expect(await waiting).toEqual({ status: "cancelled" });
          await manager.drain();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        }
      } finally {
        release.resolve();
        await result;
        spy.mockRestore();
        manager.close();
        await waiting;
        await manager.drain();
      }
    }),
);

it.each(["sessionId", "lifecycleRevision"] as const)(
  "rejects stale bindings after %s replacement under the same key",
  (field) =>
    withOwnRunQuestion(async (f) => {
      const id = await f.request();
      const waiting = manager.waitAnswer(id);
      replaceSessionEntrySync(sessionScope, { ...f.entry, [field]: "replacement", updatedAt: 2 });
      expect(await f.call("get", { id })).toMatchObject(questionNotFound);
      expect(await waiting).toEqual({ status: "cancelled" });
      await manager.drain();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      for (const method of ["waitAnswer", "resolve"]) {
        expect(
          await f.call(method, { id, ...(method === "resolve" ? { answers } : {}) }),
        ).toMatchObject(questionNotFound);
      }
      expect((await f.call("list", {}))[1]).toEqual({ questions: [] });
      await manager.drain();
      expect(f.browser.socket.send).toHaveBeenCalledOnce();
    }),
);

it.each(["client invalidation", "request authority revocation"] as const)(
  "fences answer delivery after %s without losing accepted truth",
  (cause) =>
    withOwnRunQuestion(async (f) => {
      const id = await f.request();
      const observer: GatewayClient = { ...f.browser.client };
      let current = true;
      const waiting = await f.beginWait(id, observer, () => current);
      const rejected = expect(waiting.result).rejects.toThrow(
        "Gateway requester authority changed",
      );
      if (cause === "client invalidation") {
        observer.invalidated = true;
      } else {
        current = false;
      }
      expect((await f.call("resolve", { id, answers }))[0]).toBe(true);
      await rejected;
      expect((await f.call("get", { id }))[1]).toMatchObject({
        question: { id, status: "answered", answers },
      });
    }),
);
