import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as inProcessGateway from "../../agents/tools/in-process-gateway.js";
import { prepareSessionsSendCommunication } from "../../agents/tools/sessions-send-communication.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as runs from "../../infra/agent-run-registry.js";
import type { CommunicationEndpoint } from "../../sessions/communication-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { requestSessionCommunicationApproval } from "../session-communication-approval.js";
import { resolveGatewaySessionStoreTargetInWorker as loadTarget } from "../session-utils-store-worker.js";
import {
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();
async function createFixture(state: OpenClawTestState) {
  const storePath = state.path("sessions.json");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: { entries: { main: {} } },
  };
  setRuntimeConfigSnapshot(cfg);
  const creator = createOperatorClient({ profileId: "recipient", scopes: ["operator.write"] });
  const admin = createOperatorClient({ profileId: "admin", scopes: ["operator.admin"] });
  const peer = createOperatorClient({
    profileId: "sender",
    scopes: ["operator.questions", "operator.write"],
  });
  const endpoint: CommunicationEndpoint = {
    agentId: "main",
    sessionKey: "agent:main:communication-recipient",
    storePath,
    entry: {
      sessionId: "recipient-session",
      updatedAt: 1,
      communication: { receive: "ask" },
      createdActor: { type: "human", source: "profile", id: "recipient" },
    },
  };
  const write = (key: string, entry: SessionEntry) =>
    upsertSessionEntryCore({ agentId: "main", sessionKey: key, storePath }, entry);
  await write(endpoint.sessionKey, endpoint.entry!);
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    questionManager: manager,
    broadcast,
  });
  const ask = (signal?: AbortSignal) =>
    requestSessionCommunicationApproval({
      context,
      approval: { direction: "receive", endpoint },
      source: { ...endpoint, sessionKey: "agent:main:sender" },
      target: endpoint,
      message: "exact message\n  with whitespace ",
      assertCurrent: () => {},
      signal,
    });
  const resolve = (client: GatewayClient, id: string, decision = "Allow once") =>
    callQuestionRpc(
      "question.resolve",
      { id, answers: { answers: { communication: [decision] } } },
      { cfg, client },
    );
  const get = (client: GatewayClient, id: string) =>
    callQuestionRpc("question.get", { id }, { cfg, client });
  return { endpoint, cfg, creator, admin, peer, ask, context, write, resolve, get };
}

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) =>
    run(await createFixture(state)),
  );
}

const beforeAdmission = (question: Promise<string>, pending: Promise<unknown>) =>
  Promise.race([
    question,
    pending.then(() => expect.unreachable("Expected approval before admission")),
  ]);

it("publishes to the real recipient under sender ALS and refuses model/admin self-approval", () =>
  fixture(async ({ endpoint, creator, admin, ask, resolve }) => {
    const model = { ...admin, internal: { syntheticClient: true as const } };
    broadcast.mockImplementation((event, _payload, options) => {
      if (event === "question.requested") {
        expect(options?.questionRecipient?.(creator)).toBe(true);
        expect(options?.questionRecipient?.(model)).toBe(false);
      }
    });
    const pending = withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:sender" },
      () => ask(),
    );
    const question = manager.list()[0]!;
    expect(question.sessionKey).toBe(endpoint.sessionKey);
    expect(question.questions[0]?.header.length).toBeLessThanOrEqual(12);
    expect(question.questions[0]?.question).toContain("exact message\n  with whitespace ");
    expect((await resolve(model, question.id))[0]).toBe(false);
    expect(manager.get(question.id)?.status).toBe("pending");
    expect((await resolve(creator, question.id))[0]).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  }));

it("retains creator/admin rights without treating assigned responsibility as authority", () =>
  fixture(async ({ endpoint, cfg, creator, admin, peer, ask, resolve, get }) => {
    endpoint.entry!.owner = { actor: { type: "human", id: "sender" } };
    const pending = expect(ask()).rejects.toThrow("not authorized");
    const id = manager.list()[0]!.id;
    const canRead = async (client: GatewayClient) => (await get(client, id))[0];
    const access = [await canRead(creator), await canRead(admin), await canRead(peer)];
    expect(access).toEqual([true, true, false]);
    expect((await callQuestionRpc("question.list", {}, { cfg, client: peer }))[1]).toEqual({
      questions: [],
    });
    const solo = { ...admin, internal: { operatorRoleActor: { kind: "system" as const } } };
    expect(await canRead(solo)).toBe(true);
    creator.invalidated = true;
    await expect(canRead(creator)).rejects.toThrow("requester authority changed");
    await resolve(admin, id, "Deny");
    await pending;
  }));

it("rejects an already displayed decision after the recipient incarnation changes", () =>
  fixture(async ({ endpoint, creator, admin, ask, resolve, write }) => {
    const denied = expect(ask()).rejects.toThrow("not authorized");
    const id = manager.list()[0]!.id;
    await write(endpoint.sessionKey, {
      ...endpoint.entry!,
      sessionId: "replacement-recipient-session",
      lifecycleRevision: "replacement-recipient-lifecycle",
    });
    expect((await resolve(creator, id))[0]).toBe(false);
    expect(manager.get(id)?.status).toBe("pending");
    expect((await resolve(admin, id))[0]).toBe(false);
    manager.cancel(id, "recipient-replaced");
    await denied;
  }));

it("cancellation and expiration settle without approval and cannot be released by later policy changes", () =>
  fixture(async ({ ask }) => {
    const controller = new AbortController();
    const cancelledCheck = expect(ask(controller.signal)).rejects.toThrow();
    controller.abort();
    await cancelledCheck;
    const expiredCheck = expect(ask()).rejects.toThrow("not authorized");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await expiredCheck;
    expect(manager.list()).toEqual([]);
  }));

it.each(["Allow once", "Deny"] as const)(
  "missing configured main gets real recipient consent after empty creation: %s",
  (decision) =>
    fixture(async ({ endpoint, cfg, creator, admin, context, write, resolve }) => {
      cfg.session!.communication = { send: "ask", receive: "ask" };
      setRuntimeConfigSnapshot(cfg);
      const read = async (key: string): Promise<CommunicationEndpoint> => {
        const loaded = await loadTarget({ cfg, key, agentId: "main" });
        return {
          agentId: loaded.agentId,
          sessionKey: loaded.canonicalKey,
          storePath: loaded.readSource?.path ?? loaded.storePath,
          entry: loaded.store[loaded.canonicalKey],
        };
      };
      const source = await read(endpoint.sessionKey);
      const target = await read("agent:main:main");
      expect(target.entry).toBeUndefined();
      const questions = new Map(
        [source, target].map(({ sessionKey }) => [sessionKey, createDeferredCore<string>()]),
      );
      broadcast.mockImplementation((event, payload) => {
        if (event === "question.requested") {
          const { id, sessionKey } = payload as { id: string; sessionKey: string };
          questions.get(sessionKey)?.resolve(id);
        }
      });
      const ensureTarget = vi.fn(async (assertCurrent: () => void) => {
        assertCurrent();
        await write(target.sessionKey, {
          sessionId: "created-empty-main",
          updatedAt: 1,
          createdActor: { type: "agent", id: source.sessionKey },
        });
        assertCurrent();
        return read(target.sessionKey);
      });
      const callGateway = vi
        .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
        .mockResolvedValue(undefined);
      const operationalRunInstance = createOperationalRunInstanceRef("communication-sender");
      const authority = runs.claimAgentRunDelegatedAuthority(operationalRunInstance);
      try {
        const pending = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: source.sessionKey,
            gatewayContextResolver: () => context,
            operationalRunInstance,
            approvalAuthority: authority,
            receiptAuthority: () => runs.validateAgentRunDelegatedAuthority(authority),
          },
          () =>
            prepareSessionsSendCommunication({
              config: cfg,
              source,
              target,
              message: "exact new-main message",
              ensureTarget,
              callGateway: inProcessGateway.callAgentToolGatewayRequest,
            }),
        );
        const observed = Promise.allSettled([pending]);
        const senderId = await beforeAdmission(questions.get(source.sessionKey)!.promise, pending);
        expect(ensureTarget).not.toHaveBeenCalled();
        expect(callGateway).not.toHaveBeenCalled();
        expect((await resolve(creator, senderId))[0]).toBe(true);
        const recipientId = await beforeAdmission(
          questions.get(target.sessionKey)!.promise,
          pending,
        );
        expect(ensureTarget).toHaveBeenCalledOnce();
        expect(callGateway).not.toHaveBeenCalled();
        const recipient = manager.get(recipientId);
        expect(recipient).toMatchObject({ sessionKey: target.sessionKey, status: "pending" });
        expect((await read(target.sessionKey)).entry?.sessionId).toBe("created-empty-main");
        expect((await resolve(admin, recipientId, decision))[0]).toBe(true);
        const [result] = await observed;
        if (result.status === "rejected") {
          expect(decision).toBe("Deny");
          expect(result.reason).toBeInstanceOf(Error);
          expect(callGateway).not.toHaveBeenCalled();
        } else {
          expect(decision).toBe("Allow once");
          const gate = result.value;
          expect(gate).toBeDefined();
          await gate.callGateway({
            method: "agent",
            params: {
              agentId: "main",
              sessionKey: target.sessionKey,
              message: "exact new-main message",
            },
          });
          expect(callGateway).toHaveBeenCalledOnce();
          gate.close();
        }
      } finally {
        callGateway.mockRestore();
        runs.releaseAgentRunDelegatedAuthority(authority);
      }
    }),
);
