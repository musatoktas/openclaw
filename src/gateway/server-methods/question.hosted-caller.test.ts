import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createAskUserTool } from "../../agents/tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { OperatorScope } from "../operator-scopes.js";
import { QuestionManager } from "../question-manager.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchGatewayMethodInProcessRaw } from "../server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

afterEach(resetPendingAskUserQuestionsForTest);

const sessionKey = "agent:main:hosted-question";
const question = { header: "Destination", question: "Where next?" };
const answers = () => ({ answers: { destination: ["Home"] } });
const answered = { status: "answered", answers: answers() };
const notFound = { reason: "QUESTION_NOT_FOUND" };
const toolArgs = {
  questions: [
    {
      id: "destination",
      ...question,
      options: [{ label: "Home" }, { label: "Elsewhere" }],
    },
  ],
};

async function createHostedQuestion(
  state: OpenClawTestState,
  foreign = false,
  broadRole?: "write" | "view" | "none",
) {
  const cfg = rolePolicyConfig();
  const role = broadRole ?? "view";
  const scopes: OperatorScope[] = [broadRole ? "operator.questions" : "operator.sessions.write"];
  cfg.gateway!.roles!.definitions[role]!.scopes = scopes;
  cfg.session = { store: state.path("sessions.json") };
  cfg.agents = { defaults: { workspace: state.workspaceDir }, entries: { main: {} } };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const browser = roleClient(role, "hosted-question-owner");
  browser.connect.scopes = scopes;
  const profileId = expectDefined(browser.authenticatedUserProfile, "original person").profileId;
  const scope = { agentId: "main", sessionKey, storePath: cfg.session.store };
  await upsertSessionEntryCore(scope, {
    sessionId: "hosted-question-session",
    lifecycleRevision: "hosted-question-generation",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: foreign ? "other-person" : profileId },
  });
  expect(loadSessionEntry(scope)?.createdActor?.id).toBe(foreign ? "other-person" : profileId);
  const scheduler = createTestGatewayScheduler();
  const manager = new QuestionManager(scheduler);
  const waiting = createDeferredCore();
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    questionManager: manager,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  });
  context.resolveGatewayContext = () => context;
  const source = new AbortController();
  const captured = expectDefined(
    await captureGatewayOperatorRunAuthority({
      client: browser,
      context,
      sourceAuthority: {
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      },
    }),
    "original operator source",
  );
  const parent = prepareSystemAgentRunAdmission(
    cfg,
    "hosted-question-run",
    "main",
    "question-test",
    undefined,
    captured.authority,
  );
  const admitted = await parent.admit("embedded");
  bindGatewayContextResolver(admitted, () => context);
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey,
    }),
    "hosted caller",
  );
  const handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    scheduler,
  );
  const request = vi.fn(async (options: GatewayRequestHandlerOptions) => {
    const client = options.client;
    const internal = client?.internal;
    expect(internal?.syntheticClient).toBe(true);
    expect(client?.connect.scopes).toEqual(scopes);
    expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
      broadRole ? undefined : "operator.sessions.write",
    );
    expect(internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
    expect(internal?.operatorRunAuthority?.source).toBe(captured.authority.source);
    const identity = internal?.agentRuntimeIdentity;
    if (broadRole) {
      expect(identity).toBeUndefined();
    } else {
      const trustedIdentity = expectDefined(identity, "trusted runtime producer");
      expect(trustedIdentity).toMatchObject({
        agentId: "main",
        sessionKey,
        operationalRunInstance: admitted.operationalRunInstance,
      });
      expect(context.validateAgentRuntimeApprovalAuthority?.(trustedIdentity)).toBe(true);
    }
    await expectDefined(handlers["question.request"], "question producer")(options);
  });
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      scope: "operator.questions" as const,
      owner: { kind: "core" as const, area: "questions" },
      handler: async (options: GatewayRequestHandlerOptions) => {
        if (name === "question.request") {
          return request(options);
        }
        const client = options.client;
        if (broadRole && client?.internal?.syntheticClient) {
          expect(client.authenticatedUserProfile).toBeUndefined();
          expect(client.internal.operatorRoleActor).toEqual({ kind: "operator", profileId });
          expect(client.connect.scopes).toEqual(["operator.questions"]);
        }
        if (name === "question.waitAnswer") {
          expect(client?.connect.scopes).toEqual(["operator.sessions.write"]);
          expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
            "operator.sessions.write",
          );
          waiting.resolve();
        }
        await handler(options);
      },
    })),
  );
  context.getGatewayMethodRegistry = () => registry;
  const browserRequest = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: "browser-question", method, params },
      client: browser,
      context,
      respond,
      isWebchatConnect: () => false,
      methodRegistry: registry,
    });
    return expectDefined(respond.mock.calls[0], "browser question response");
  };
  const closeParent = () => {
    parent.close();
    captured.release();
  };
  return {
    ask: () =>
      withGatewayToolCallerIdentity(caller, async () => {
        const tool = createAskUserTool({
          agentId: "main",
          sessionKey,
          runId: admitted.operationalRunInstance.runId,
        });
        return await tool.execute("hosted-question-call", toolArgs);
      }),
    waiting: waiting.promise,
    manager,
    request,
    answer: (id: string) => browserRequest("question.resolve", { id, answers: answers() }),
    read: (id: string) => browserRequest("question.get", { id }),
    hosted: (method: string, params: Record<string, unknown>) =>
      withGatewayToolCallerIdentity(caller, () =>
        dispatchGatewayMethodInProcessRaw(method, params, {
          syntheticScopes: ["operator.questions"],
          resolveGatewayContext: caller.gatewayContextResolver,
        }),
      ),
    revoke: () => source.abort(new Error("original question source revoked")),
    closeParent,
    close: async () => {
      manager.close();
      await manager.drain();
      closeParent();
    },
  };
}

async function withHostedQuestion(
  run: (fixture: Awaited<ReturnType<typeof createHostedQuestion>>) => Promise<void>,
  foreign = false,
  role?: "write" | "view" | "none",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createHostedQuestion(state, foreign, role);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}

it("runs hosted ask_user through the real router with its original narrow operator grant", async () => {
  await withHostedQuestion(async (fixture) => {
    const { ask, waiting, manager, request, answer, read, closeParent, revoke } = fixture;
    const result = ask();
    const settled = Promise.allSettled([result]);
    try {
      await Promise.race([
        waiting,
        result.then(() => {
          throw new Error("ask_user settled before its waiter");
        }),
      ]);
      expect(request).toHaveBeenCalledOnce();
      const record = expectDefined(manager.list()[0], "accepted question");
      expect(record).toMatchObject({
        agentId: "main",
        sessionKey,
        runId: "hosted-question-run",
        status: "pending",
      });
      expect(await answer(record.id)).toMatchObject([true, answered, undefined]);
      expect((await result).details).toMatchObject(answered);
      closeParent();
      expect(await read(record.id)).toMatchObject([
        true,
        { question: { status: "answered" } },
        undefined,
      ]);
      revoke();
      expect(await read(record.id)).toMatchObject([false, undefined, { details: notFound }]);
      expect(manager.get(record.id)?.status).toBe("answered");
    } finally {
      manager.close();
      await settled;
    }
  });
});

it.each([
  [true, "session is shared for this connection"],
  [false, "original question source revoked"],
] as const)("rejects hosted creation (foreign session: %s) with %s", async (foreign, error) => {
  await withHostedQuestion(async (fixture) => {
    if (!foreign) {
      fixture.revoke();
    }
    await expect(fixture.ask()).rejects.toThrow(error);
    expect(fixture.request).toHaveBeenCalledTimes(foreign ? 1 : 0);
    expect(fixture.manager.list()).toEqual([]);
  }, foreign);
});

it.each(["write", "view", "none"] as const)(
  "uses the original role-only hosted actor's %s cap for broad shared questions",
  async (role) => {
    await withHostedQuestion(
      async ({ manager, hosted, request: requestSpy }) => {
        const request = {
          id: "broad-shared",
          agentId: "main",
          sessionKey,
          timeoutMs: 60_000,
          questions: [
            {
              questionId: "destination",
              ...question,
              options: [],
              isOther: true,
            },
          ],
        };
        manager.request(request);
        const sql = observeHostDataSql();
        try {
          const read = await hosted("question.get", { id: request.id });
          expect(read.ok).toBe(role !== "none");
          if (role === "none") {
            expect(read.error?.details).toMatchObject(notFound);
          } else {
            expect(read.payload).toMatchObject({ question: { id: request.id, status: "pending" } });
          }
          const answer = await hosted("question.resolve", { id: request.id, answers: answers() });
          expect(answer.ok).toBe(role === "write");
          if (role !== "write") {
            expect(answer.error?.details).toMatchObject(
              role === "none" ? notFound : { code: "SESSION_PARTICIPATION_REQUIRED" },
            );
          }
          expect(manager.get(request.id)?.status).toBe(role === "write" ? "answered" : "pending");
          const created = await hosted("question.request", { ...request, id: "broad-created" });
          expect(created.ok).toBe(role === "write");
          expect(requestSpy).toHaveBeenCalledOnce();
          expect(manager.get("broad-created")?.status).toBe(
            role === "write" ? "pending" : undefined,
          );
          expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
        } finally {
          sql.restore();
        }
      },
      true,
      role,
    );
  },
);
