import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc,
  createProjectedQuestionBroadcaster,
  createQuestionSource,
  createQuestionPeer as questionPeer,
  observeQuestionWait,
  questionNotFound,
  questionOk as ok,
  questionError as errorReply,
  installQuestionTestHooks,
  manager,
  requesterAuthority,
  requestParams,
  secretRequestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const id = "ordinary-question";

function broadClient(client: GatewayClient): GatewayClient {
  return { ...client, connect: { ...client.connect, scopes: ["operator.questions"] } };
}

function broadcastTo(...peers: ReturnType<typeof questionPeer>[]) {
  const broadcaster = createGatewayBroadcaster({
    clients: new GatewayClientRegistry(peers.map((peer) => peer.ws)),
  });
  broadcast.mockImplementation(broadcaster.broadcast);
  return broadcaster;
}

function invalidateQuestionReadFacts() {
  sessionChanges.invalidate({
    agentId: "main",
    sessionKey: requestParams.sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    factsInvalidated: true,
  });
}

const sourceReleases = new Set<() => void>();
afterEach(() => {
  for (const release of sourceReleases) {
    release();
  }
  sourceReleases.clear();
});

async function fixture(state: OpenClawTestState) {
  const owner = roleClient("view", "question-owner");
  const viewer = roleClient("write", "question-viewer");
  const cfg = rolePolicyConfig(["guest"]);
  cfg.gateway!.roles!.definitions.view!.scopes.push("operator.questions");
  cfg.gateway!.roles!.definitions.write!.sessions.others = "view";
  cfg.gateway!.roles!.definitions.write!.scopes.push("operator.questions");
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  owner.connect.scopes = ["operator.sessions.write"];
  viewer.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const { source, controller: sourceController } = await createQuestionSource(owner, cfg, true);
  sourceReleases.add(source.release);
  const producer: GatewayClient = {
    ...owner,
    internal: {
      ...owner.internal,
      operatorRunAuthority: source.authority,
      agentRuntimeIdentity: adminRequestClient.internal!.agentRuntimeIdentity,
    },
  };
  const ownerId = owner.authenticatedUserProfile!.profileId;
  const entry: SessionEntry = {
    sessionId: "question-session",
    lifecycleRevision: "question-generation",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: ownerId },
  };
  const write = (delta: Partial<SessionEntry> = {}) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { ...entry, ...delta },
    );
  await write();
  const call = (
    method: string,
    params: Record<string, unknown>,
    client = owner,
    current?: () => boolean,
  ) =>
    callQuestionRpc(`question.${method}`, params, {
      client,
      cfg,
      registered: true,
      hasCurrentClientAuthority: current,
    });
  const request = (questionId = id, client = producer) =>
    call("request", { ...requestParams, id: questionId, timeoutMs: 10_000 }, client);
  return { owner, viewer, producer, cfg, entry, write, call, request, sourceController, state };
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => run(await fixture(state)));
}

it("routes trusted narrow questions through worker RPCs, label changes, and completion", () =>
  withFixture(async (f) => {
    const owner = questionPeer(f.owner, "sql-owner");
    const viewer = questionPeer(f.viewer, "sql-viewer");
    const broad = questionPeer(broadClient(f.owner), "sql-broad");
    const admin = questionPeer(adminRequestClient, "sql-admin");
    const revoked = questionPeer({ ...f.viewer, invalidated: true }, "sql-revoked");
    const fallback = vi.fn(() => false);
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([owner.ws, viewer.ws, broad.ws, admin.ws, revoked.ws]),
      canReceiveSessionEvent: fallback,
    });
    broadcast.mockImplementation(broadcaster.broadcast);
    let sql = observeHostDataSql();
    const { entered, spy: waitSpy } = observeQuestionWait();
    let settled: Promise<unknown> | undefined;
    try {
      expect(
        await f.call(
          "request",
          {
            ...requestParams,
            id: "trusted-route",
            agentId: "other",
            sessionKey: "agent:other:foreign",
            runId: "forged",
          },
          f.producer,
        ),
      ).toMatchObject(ok({ id: "trusted-route" }));
      expect(manager.get("trusted-route")).toMatchObject({
        agentId: "main",
        sessionKey: requestParams.sessionKey,
        runId: requestParams.runId,
      });
      expect((await f.call("get", { id: "trusted-route" }))[0]).toBe(true);
      expect((await f.call("list", {}))[0]).toBe(true);
      const waiting = f.call("waitAnswer", { id: "trusted-route" });
      settled = Promise.allSettled([waiting]);
      await Promise.race([entered, waiting]);
      waitSpy.mockRestore();
      expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
      sql.restore();
      await f.write({ updatedAt: 2, label: "Renamed while answering", markedUnreadAt: 2 });
      sql = observeHostDataSql();
      const answers = { answers: { destination: ["Home"] } };
      expect(await f.call("resolve", { id: "trusted-route", answers })).toEqual(
        ok({ status: "answered", answers }),
      );
      // Completion retires requester liveness, not the ordinary question's retained read facts.
      releaseAgentRunDelegatedAuthority(requesterAuthority);
      expect(await waiting).toEqual(ok({ status: "answered", answers }));
      expect(await f.call("get", { id: "trusted-route" })).toMatchObject(
        ok({ question: { status: "answered", answers } }),
      );
      await manager.drain();
      for (const recipient of [owner, broad, admin]) {
        expect(recipient.send.mock.calls.map(([frame]) => JSON.parse(frame).event)).toEqual([
          "question.requested",
          "question.resolved",
        ]);
      }
      expect(viewer.send).not.toHaveBeenCalled();
      expect(revoked.send).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
      expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
    } finally {
      waitSpy.mockRestore();
      sql.restore();
      manager.close();
      await settled;
      await manager.drain();
    }
  }));

it("retains requester-only fanout across draft visibility changes", () =>
  withFixture(async (f) => {
    const owner = questionPeer(f.owner, "question-owner");
    const viewer = questionPeer(f.viewer, "question-viewer");
    const broad = questionPeer(broadClient(f.owner), "broad-questions");
    const projection = await createSessionRowProjection({ cfg: f.cfg });
    sourceReleases.add(() => projection.dispose());
    await projection.ensureMaterialized();
    const broadcaster = createProjectedQuestionBroadcaster(
      f.cfg,
      projection,
      new GatewayClientRegistry([owner.ws, viewer.ws, broad.ws]),
    );
    broadcast.mockImplementation(broadcaster.broadcast);
    expect((await f.request())[0]).toBe(true);
    expect(owner.send).toHaveBeenCalledOnce();
    expect(viewer.send).not.toHaveBeenCalled();
    expect(broad.send).toHaveBeenCalledOnce();
    await f.write({ visibility: "draft" });
    owner.send.mockClear();
    viewer.send.mockClear();
    broad.send.mockClear();
    manager.resolve(id, { answers: { destination: ["Own answer"] } });
    await manager.drain();
    expect(owner.send).toHaveBeenCalledOnce();
    expect(viewer.send).not.toHaveBeenCalled();
    expect(broad.send).toHaveBeenCalledOnce();
    const resolved = broadcast.mock.calls.find(([event]) => event === "question.resolved")!;
    manager.reset();
    manager.request({ ...requestParams, id });
    owner.send.mockClear();
    broad.send.mockClear();
    broadcaster.broadcast(resolved[0], resolved[1], resolved[2]);
    expect(owner.send).not.toHaveBeenCalled();
    // Prepared sharing is scoped to the original synchronous fanout, including broad clients.
    expect(broad.send).not.toHaveBeenCalled();
    for (const event of [
      "question.requested",
      "question.resolved",
      "exec.approval.requested",
      "config.changed",
    ]) {
      owner.send.mockClear();
      viewer.send.mockClear();
      broadcaster.broadcast(event, { id: "unbound" });
      expect(owner.send).not.toHaveBeenCalled();
      expect(viewer.send).not.toHaveBeenCalled();
    }
  }));

it.each(["ordinary", "secret"] as const)(
  "conceals privileged %s questions from narrow readers and fanout",
  (kind) =>
    withFixture(async (f) => {
      const peer = questionPeer(f.owner, "narrow-secret");
      const { send } = peer;
      broadcastTo(peer);
      const privilegedId = "privileged-question";
      const client = kind === "secret" ? adminRequestClient : broadClient(f.producer);
      const params = {
        ...(kind === "secret" ? secretRequestParams : requestParams),
        id: privilegedId,
      };
      expect((await f.call("request", params, client))[0]).toBe(true);
      if (kind === "secret") {
        const answers = { answers: { secret_value: ["synthetic-test-value"] } };
        expect((await f.call("resolve", { id: privilegedId, answers }, client))[0]).toBe(true);
        await manager.drain();
        expect(broadcast.mock.calls.map(([event]) => event)).toEqual([
          "question.requested",
          "question.resolved",
        ]);
      } else {
        expect(await f.call("resolve", { id: privilegedId, cancel: true })).toMatchObject(
          questionNotFound,
        );
      }
      for (const method of ["get", "waitAnswer"]) {
        expect(await f.call(method, { id: privilegedId })).toMatchObject(questionNotFound);
      }
      expect(await f.call("list", {})).toEqual(ok({ questions: [] }));
      expect(manager.get(privilegedId)?.status).toBe(kind === "secret" ? "answered" : "pending");
      expect((await f.call("get", { id: privilegedId }, client))[0]).toBe(true);
      expect(send).not.toHaveBeenCalled();
    }),
);

it.each(["pending", "answered"] as const)("retains physical store identity while %s", (status) =>
  withFixture(async (f) => {
    expect((await f.request())[0]).toBe(true);
    if (status === "answered") {
      manager.resolve(id, { answers: { destination: ["Original"] } });
    }
    const waiting = manager.waitAnswer(id);
    const replacement = f.state.statePath("replacement", "catalog.sqlite");
    await upsertSessionEntryCore(
      { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
      f.entry,
    );
    f.cfg.session = { ...f.cfg.session, store: replacement };
    await f.state.writeConfig(f.cfg);
    setRuntimeConfigSnapshot(f.cfg);
    expect(await f.call("get", { id })).toMatchObject(questionNotFound);
    expect(await waiting).toMatchObject({ status: status === "pending" ? "cancelled" : status });
    expect(await f.call("waitAnswer", { id })).toMatchObject(questionNotFound);
  }),
);

it.each(["closed claim", "absent", "incognito", "disallowed agent"] as const)(
  "rejects %s creation before recording a question",
  (kind) =>
    withFixture(async (f) => {
      let client = f.producer;
      if (kind === "closed claim") {
        releaseAgentRunDelegatedAuthority(requesterAuthority);
      }
      if (kind === "disallowed agent") {
        f.cfg.gateway!.roles!.definitions.view!.agents = ["guest"];
        await f.state.writeConfig(f.cfg);
        setRuntimeConfigSnapshot(f.cfg);
      }
      if (kind === "absent") {
        client = {
          ...client,
          internal: {
            ...client.internal,
            agentRuntimeIdentity: {
              ...client.internal!.agentRuntimeIdentity!,
              sessionKey: "agent:main:missing",
            },
          },
        };
      }
      if (kind === "incognito") {
        await f.write({ incognito: true });
      }
      const response = await f.call(
        "request",
        {
          ...requestParams,
          id: "refused-question",
        },
        client,
      );
      expect(response.slice(0, 2)).toEqual([false, undefined]);
      expect(manager.get("refused-question")).toBeNull();
    }),
);

it.each(["generation", "session", "profile", "reused id"] as const)(
  "rechecks held answers after %s",
  (change) =>
    withFixture(async (f) => {
      expect((await f.request(id))[0]).toBe(true);
      const { entered, spy } = observeQuestionWait(false);
      const observer = { ...f.owner };
      const waiting = f.call("waitAnswer", { id }, observer);
      const settled = Promise.allSettled([waiting]);
      const answers = { answers: { destination: ["Committed answer"] } };
      try {
        await Promise.race([entered, waiting]);
        expect(spy).toHaveBeenCalledOnce();
        if (change === "generation") {
          await f.write({ lifecycleRevision: "replacement" });
        }
        if (change === "session") {
          await f.write({ sessionId: "replacement" });
        }
        if (change === "profile") {
          observer.authenticatedUserProfile = f.viewer.authenticatedUserProfile;
        }
        if (change === "reused id") {
          manager.reset();
          manager.request({ ...requestParams, id });
        } else {
          manager.resolve(id, answers);
        }
        const outcome = (await settled)[0];
        const error =
          change === "profile"
            ? { code: "FORBIDDEN", message: "Gateway requester authority changed" }
            : { details: { reason: "QUESTION_NOT_FOUND" } };
        expect(outcome).toMatchObject({
          status: "fulfilled",
          value: errorReply(error),
        });
        expect(manager.get(id)?.status).toBe(change === "reused id" ? "pending" : "answered");
      } finally {
        manager.close();
        await settled;
        spy.mockRestore();
      }
    }),
);

it.each([
  "close",
  "reused id",
  "generation",
  "unrelated",
  "publication delay",
  "database close",
  "database replacement",
] as const)(
  "joins terminal preparation after %s without stale publication or lost answers",
  (change) =>
    withFixture(async (f) => {
      const owner = questionPeer(f.owner, "held-owner");
      broadcastTo(owner);
      expect((await f.request())[0]).toBe(true);
      owner.send.mockClear();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      invalidateQuestionReadFacts();
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      let held = false;
      const spy = vi
        .spyOn(projectionLane.pool, "run")
        .mockImplementation(async (input, options) => {
          let exact = false;
          const result = await run(async () => {
            const request = typeof input === "function" ? await input() : input;
            exact = request.kind === "session-exact-entries";
            return request;
          }, options);
          if (exact && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const answer = { answers: { destination: ["Committed"] } };
      const observation = manager.observe(id)!;
      const releaseAccess =
        change === "publication delay"
          ? vi.spyOn(observation.sessionAccess!, "release")
          : undefined;
      const waiting = manager.waitAnswer(id);
      manager.resolve(id, answer);
      try {
        await entered.promise;
        expect(await waiting).toEqual({ status: "answered", answers: answer });
        if (change === "publication delay") {
          await vi.advanceTimersByTimeAsync(15_001);
          expect(observation.isCurrent()).toBe(true);
          expect(releaseAccess).not.toHaveBeenCalled();
          expect(owner.send).not.toHaveBeenCalled();
        }
        if (change === "reused id") {
          manager.reset();
          manager.request({ ...requestParams, id });
        }
        if (change === "close") {
          manager.close();
        }
        if (change === "generation") {
          await f.write({ lifecycleRevision: "replacement" });
        }
        if (change === "database close") {
          await closeOpenClawAgentDatabaseByPathAsync(
            resolveOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env }),
          );
        }
        if (change === "database replacement") {
          const replacement = f.state.statePath("replacement.sqlite");
          await upsertSessionEntryCore(
            { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
            f.entry,
          );
          await closeOpenClawAgentDatabaseByPathAsync(replacement);
          const original = resolveOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
          fs.renameSync(original, f.state.statePath("original.sqlite"));
          fs.copyFileSync(replacement, original);
        }
        if (change === "unrelated") {
          sessionChanges.emit({ agentId: "main", sessionKey: "agent:main:unrelated" });
        }
        release.resolve();
        await manager.drain();
        expect(owner.send).toHaveBeenCalledTimes(
          ["unrelated", "publication delay"].includes(change) ? 1 : 0,
        );
        if (change === "publication delay") {
          expect(JSON.parse(String(owner.send.mock.calls[0]?.[0]))).toMatchObject({
            type: "event",
            event: "question.resolved",
            payload: { id, status: "answered", answers: answer },
          });
          await vi.advanceTimersByTimeAsync(14_999);
          expect(observation.isCurrent()).toBe(true);
          expect(releaseAccess).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(manager.get(id)).toBeNull();
          expect(releaseAccess).toHaveBeenCalledOnce();
        }
        if (change === "unrelated") {
          expect(spy).toHaveBeenCalledOnce();
        }
        if (change === "generation") {
          expect(manager.get(id)).toMatchObject({
            status: "answered",
            answers: answer,
          });
        }
        if (change === "reused id") {
          expect(manager.get(id)?.status).toBe("pending");
        }
      } finally {
        release.resolve();
        await manager.drain();
        spy.mockRestore();
        releaseAccess?.mockRestore();
      }
    }),
);

it.each([
  ["get", "request authority", "narrow"],
  ["get", "observer scope", "narrow"],
  ["request", "request authority", "admin"],
  ["request", "request authority", "broad"],
] as const)("fences %s when %s closes during %s worker preparation", (method, owner, kind) =>
  withFixture(async (f) => {
    if (method === "get") {
      expect((await f.request())[0]).toBe(true);
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    invalidateQuestionReadFacts();
    const read = sessionEntryReads.withSessionEntriesFromStoresInWorker;
    const spy = vi
      .spyOn(sessionEntryReads, "withSessionEntriesFromStoresInWorker")
      .mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return read(...args);
      });
    let current = true;
    const observer = new AsyncWorkScope();
    broadcast.mockClear();
    const client =
      kind === "admin" ? adminRequestClient : kind === "narrow" ? f.owner : broadClient(f.producer);
    const call = () =>
      f.call(method, { id, ...(method === "request" ? requestParams : {}) }, client, () => current);
    const request = method === "get" ? observer.track(call) : call();
    const result = Promise.allSettled([request]);
    try {
      await entered.promise;
      if (method === "get") {
        await f.write({ updatedAt: 2 });
      }
      if (owner === "request authority") {
        current = false;
      } else {
        observer.beginClose();
      }
      release.resolve();
      if (method === "get") {
        expect((await result)[0]).toMatchObject({
          status: "rejected",
          reason:
            owner === "request authority"
              ? { message: "Gateway requester authority changed" }
              : { name: "AbortError" },
        });
        expect(spy).toHaveBeenCalledOnce();
        expect(manager.get(id)?.status).toBe("pending");
      } else {
        expect((await result)[0]).toMatchObject({ status: "rejected" });
        expect(manager.get(id)).toBeNull();
      }
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
      await observer.drain();
      spy.mockRestore();
    }
  }),
);

it.each(["admin", "narrow"] as const)(
  "preserves %s creation when optional worker facts are unavailable",
  (kind) =>
    withFixture(async (f) => {
      const failure = new Error("question fixture worker unavailable");
      const admin = questionPeer(adminRequestClient, "optional-admin");
      const narrow = questionPeer(f.viewer, "optional-narrow");
      const fallback = vi.fn(() => {
        throw new Error("Unexpected synchronous session sharing lookup");
      });
      broadcast.mockImplementation(
        createGatewayBroadcaster({
          clients: new GatewayClientRegistry([admin.ws, narrow.ws]),
          canReceiveSessionEvent: fallback,
        }).broadcast,
      );
      const spy = vi
        .spyOn(sessionEntryReads, "withSessionEntriesFromStoresInWorker")
        .mockRejectedValue(failure);
      try {
        invalidateQuestionReadFacts();
        const client = kind === "narrow" ? f.producer : adminRequestClient;
        const request = f.call("request", { ...requestParams, id: "optional-facts" }, client);
        if (kind === "narrow") {
          await expect(request).rejects.toThrow(failure);
          expect(manager.get("optional-facts")).toBeNull();
        } else {
          expect((await request)[0]).toBe(true);
          expect(manager.get("optional-facts")?.status).toBe("pending");
          expect(manager.observe("optional-facts")?.sessionAccess).toBeUndefined();
          manager.cancel("optional-facts");
          await manager.drain();
          expect(admin.send.mock.calls.map(([frame]) => JSON.parse(frame).event)).toEqual([
            "question.requested",
            "question.resolved",
          ]);
          expect(manager.get("optional-facts")?.status).toBe("cancelled");
        }
        expect(narrow.send).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }),
);

it.each(["source", "generation"] as const)(
  "delivers to broad/admin clients after narrow %s retirement",
  (change) =>
    withFixture(async (f) => {
      const source = f.sourceController;
      const narrow = questionPeer(f.owner, "retired-narrow");
      const broad = questionPeer(broadClient(f.viewer), "retired-broad");
      const admin = questionPeer(adminRequestClient, "retired-admin");
      broadcastTo(narrow, broad, admin);
      expect((await f.request())[0]).toBe(true);
      for (const recipient of [narrow, broad, admin]) {
        expect(recipient.send).toHaveBeenCalledOnce();
        recipient.send.mockClear();
      }
      if (change === "source") {
        source.abort(new Error("Original producer revoked"));
        releaseAgentRunDelegatedAuthority(requesterAuthority);
      } else {
        await f.write({ lifecycleRevision: "successor" });
        manager.resolve(id, { answers: { destination: ["Committed"] } });
      }
      await manager.drain();
      const status = change === "source" ? "cancelled" : "answered";
      expect(narrow.send).not.toHaveBeenCalled();
      for (const recipient of [broad, admin]) {
        expect(recipient.send).toHaveBeenCalledOnce();
        expect(JSON.parse(recipient.send.mock.calls[0]![0])).toMatchObject({
          event: "question.resolved",
          payload: { id, status },
        });
      }
    }),
);
