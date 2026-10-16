import { expect, it, onTestFinished, vi } from "vitest";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  getAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import * as secretsRuntimeState from "../../secrets/runtime-state.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abortChatRunById,
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../chat-abort.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createChatRunState } from "../server-chat-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc as call,
  createProjectedQuestionBroadcaster,
  createQuestionPeer,
  questionNotFound,
  installQuestionTestHooks,
  manager,
  reloadSecrets,
  requesterAuthority,
  requestParams,
  requestSecretQuestion,
  secretRequestParams,
  secretRequestQuestion,
  storeWriteService,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const ok = (payload: unknown) => [true, payload, undefined];
const failure = (error: unknown) => [false, undefined, error];
const invalidRequest = failure({ code: "INVALID_REQUEST" });
const answered = (answers = storedAnswers) => ({ status: "answered", answers });
const makeQuestion = (overrides: Partial<QuestionRequestQuestion>) => ({
  ...requestParams.questions[0],
  ...overrides,
});
const requestQuestions = (questions: QuestionRequestQuestion[], client?: GatewayClient) =>
  call("question.request", { ...requestParams, questions }, { client });
const secretQuestion = (overrides: Partial<QuestionRequestQuestion>) => ({
  ...secretRequestQuestion,
  ...overrides,
});
const storedAnswers = { answers: { secret_value: ["stored"] } };
const homeAnswers = { answers: { destination: ["Home"] } };
const stateOptions = { scenario: "minimal", prepareProfileCatalog: true } as const;
const withState = (run: () => Promise<void>) =>
  withOpenClawTestState(stateOptions, async () => {
    setRuntimeConfigSnapshot({});
    await run();
  });
const listSecrets = () => listSecretStoreEntries({ scope: { kind: "team" } });
const readSecret = () => readSecretStoreValue({ scope: { kind: "team" }, name: "SERVICE_API_KEY" });
const secretAnswers = (value: string) => ({ answers: { secret_value: [value] } });
const answerSecret = (id: string, value: string, params: Record<string, unknown> = {}) =>
  call("question.resolve", { id, answers: secretAnswers(value), ...params });
const published = (event: string, payload: unknown, options = publicationOptions) =>
  expect(broadcast).toHaveBeenCalledWith(event, payload, options);

const publicationOptions = {
  questionRecipient: expect.any(Function),
};

function mockReferencedStoreSnapshot() {
  vi.spyOn(secretsRuntimeState, "getActiveSecretsRuntimeSnapshotState").mockReturnValue({
    sourceConfig: {
      models: {
        providers: {
          test: {
            baseUrl: "https://provider.example.test",
            models: [],
            apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
          },
        },
      },
    },
    config: {},
    authStores: [],
    authStoreCredentialsRevision: 0,
    authStoreSnapshotsRevision: 0,
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  });
}

async function sharingFixture(others: "none" | "suggest" = "none") {
  const owner = ensureProfileForEmail("owner@example.test");
  const guest = ensureProfileForEmail("guest@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others }, agents: "*", scopes: ["operator.questions"] },
          viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.questions"] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: requestParams.sessionKey },
    {
      sessionId: "question-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: owner.id },
    },
  );
  const profile = (user: typeof guest) => ({
    profileId: user.id,
    displayName: user.displayName,
    avatarRevision: "",
    hasAvatar: false,
    updatedAt: user.updatedAt,
  });
  const client = {
    connect: { scopes: ["operator.questions"] },
    authenticatedUserProfile: profile(guest),
  } as GatewayClient;
  return { owner, guest, cfg, client, profile };
}

it("conceals foreign session questions for role-none readers while preserving global prompts", async () => {
  await withState(async () => {
    const { client, cfg } = await sharingFixture();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    manager.request({ ...requestParams, id: "foreign-question" });
    manager.request({
      questions: requestParams.questions,
      id: "global-question",
      timeoutMs: 100,
    });

    expect((await call("question.list", {}, { client, cfg }))[1]).toMatchObject({
      questions: [{ id: "global-question" }],
    });
    for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
      const params = {
        id: "foreign-question",
        ...(method === "question.resolve" && { cancel: true }),
      };
      expect(await call(method, params, { client, cfg })).toMatchObject(questionNotFound);
    }
    expect(manager.get("foreign-question")?.status).toBe("pending");
  });
});

it("requires membership to resolve a suggest-capped guest question", async () => {
  await withState(async () => {
    const { owner, guest, cfg, client } = await sharingFixture("suggest");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    manager.request({ ...requestParams, id: "foreign-question" });

    expect((await call("question.get", { id: "foreign-question" }, { client, cfg }))[0]).toBe(true);
    expect(
      await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
    ).toMatchObject(failure({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } }));
    addSessionMember(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { identityId: guest.id, addedBy: owner.id, expectedSessionId: "question-session" },
    );
    expect(
      await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
    ).toEqual(ok({ status: "cancelled" }));
  });
});

it("scopes requested and resolved questions to operators allowed to see their session", async () => {
  await withState(async () => {
    const { owner, guest, cfg, profile: userProfile } = await sharingFixture();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const viewer = ensureProfileForEmail("viewer@example.test");
    setUserProfileRole(viewer.id, "viewer");
    const peer = (user: typeof owner, name: string) => {
      const result = createQuestionPeer(
        {
          connect: { role: "operator", scopes: ["operator.questions"] },
          authenticatedUserProfile: userProfile(user),
        } as GatewayClient,
        name,
      );
      prepareGatewayRecipientProfile(result.ws);
      return result;
    };
    const ownerClient = peer(owner, "question-owner");
    const viewerClient = peer(viewer, "question-viewer");
    const guestClient = peer(guest, "question-guest");
    const projection = await createSessionRowProjection({ cfg });
    onTestFinished(() => projection.dispose());
    await projection.ensureMaterialized();
    const gatewayBroadcaster = createProjectedQuestionBroadcaster(
      cfg,
      projection,
      new GatewayClientRegistry([ownerClient.ws, viewerClient.ws, guestClient.ws]),
    );
    broadcast.mockImplementation(gatewayBroadcaster.broadcast);

    const request = await call("question.request", requestParams, {
      cfg,
      client: ownerClient.ws,
    });
    const id = (request[1] as { id: string }).id;
    const answers = homeAnswers;
    const sessionScope = {
      sessionKeys: [requestParams.sessionKey],
      agentId: "main",
      ...publicationOptions,
    };

    expect(ownerClient.socket.send).toHaveBeenCalledTimes(1);
    expect(viewerClient.socket.send).toHaveBeenCalledTimes(1);
    expect(guestClient.socket.send).not.toHaveBeenCalled();
    published(
      "question.requested",
      expect.objectContaining({ id, sessionKey: requestParams.sessionKey }),
      sessionScope,
    );

    await call("question.resolve", { id, answers }, { cfg, client: ownerClient.ws });
    await manager.drain();

    published("question.resolved", { id, status: "answered", answers }, sessionScope);
    expect(ownerClient.socket.send).toHaveBeenCalledTimes(2);
    expect(viewerClient.socket.send).toHaveBeenCalledTimes(2);
    expect(guestClient.socket.send).not.toHaveBeenCalled();
  });
});

const credentialUrl = new URL("https://example.test/connect");
credentialUrl.username = "fixture-user";
credentialUrl.password = "fixture-password";

it.each<[string, Partial<QuestionRequestQuestion>]>([
  ["script URL", { url: "javascript:alert(1)" }],
  ["relative URL", { url: "/connect" }],
  ["credential URL", { url: credentialUrl.href }],
  ["script thumbnail", { options: [{ label: "Unsafe", thumbnail: "javascript:alert(1)" }] }],
])("rejects %s before publishing", async (_name, fields) => {
  expect(await requestQuestions([makeQuestion(fields)])).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
});

it("rejects duplicate ids and admits a bounded rich single-option question at the request boundary", async () => {
  const duplicate = await call("question.request", {
    questions: [requestParams.questions[0], requestParams.questions[0]],
  });
  expect(duplicate).toMatchObject(
    failure({ message: expect.stringContaining("duplicate question id") }),
  );

  const oneOption = await call("question.request", {
    ...requestParams,
    id: "rich-question",
    questions: [
      makeQuestion({
        url: "https://example.test/connect",
        allowEmpty: true,
        presentation: "form",
        options: [{ label: "Only", thumbnail: "https://example.com/only.png" }],
      }),
    ],
  });
  expect(oneOption[0]).toBe(true);
  const richQuestion = expect.objectContaining({
    id: "rich-question",
    questions: [expect.objectContaining({ url: "https://example.test/connect" })],
  });
  published("question.requested", richQuestion);
  expect(await call("question.get", { id: "rich-question" })).toEqual(
    ok({ question: richQuestion }),
  );
  expect(await call("question.list", {})).toEqual(ok({ questions: [richQuestion] }));
  expect(
    (
      await call("question.resolve", {
        id: "rich-question",
        answers: { answers: { destination: [] } },
      })
    )[1],
  ).toEqual({ status: "answered", answers: { answers: { destination: [] } } });

  const clientId = "duplicate-client-id";
  expect((await call("question.request", { ...requestParams, id: clientId }))[0]).toBe(true);
  const reusedId = await call("question.request", { ...requestParams, id: clientId });
  expect(reusedId).toMatchObject(
    failure({
      code: "INVALID_REQUEST",
      details: { reason: "QUESTION_ID_IN_USE" },
    }),
  );
});

it.each<[string, Partial<QuestionRequestQuestion>, string]>([
  [
    "unbound secrets",
    { isSecret: true },
    "question 'destination': secret questions are not supported yet",
  ],
  [
    "normalized option labels",
    { options: [{ label: " Deploy " }, { label: "deploy" }] },
    "question 'destination' has duplicate option label",
  ],
])("rejects %s", async (_name, overrides, message) => {
  expect(await requestQuestions([makeQuestion(overrides)])).toMatchObject(
    failure({ message: expect.stringContaining(message) }),
  );
});

it.each<[string, QuestionRequestQuestion[]]>([
  ["bindings without the secret-input marker", [secretQuestion({ isSecret: false })]],
  ["secret requests mixed with another question", [secretRequestQuestion, makeQuestion({})]],
  [
    "invalid secret store entry names",
    [secretQuestion({ secretStore: { ...secretRequestQuestion.secretStore, name: "lowercase" } })],
  ],
])("rejects %s before opening a pending secret question", async (_name, questions) => {
  expect(await requestQuestions(questions, adminRequestClient)).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
});

it("requires admin scope to mint store-bound questions", async () => {
  const client = { connect: { scopes: ["operator.questions"] } } as GatewayClient;
  expect(await call("question.request", secretRequestParams, { client })).toMatchObject(
    failure({ code: "INVALID_REQUEST", message: expect.stringContaining("operator.admin") }),
  );
  expect(manager.list()).toEqual([]);
});

it.each(["replacement", "abort"] as const)(
  "fences a pending credential on exact requester %s while preserving ordinary questions",
  async (closure) => {
    await withState(async () => {
      const id = await requestSecretQuestion();
      const ordinary = await call("question.request", requestParams);
      const ordinaryId = (ordinary[1] as { id: string }).id;
      const waiting = manager.waitAnswer(id);
      let successor: AgentRunDelegatedAuthority | undefined;
      if (closure === "replacement") {
        successor = claimAgentRunDelegatedAuthority({
          instanceId: "successor-instance",
          runId: requestParams.runId,
        });
      } else {
        const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
        const registration = registerChatAbortController({
          chatAbortControllers,
          runId: requestParams.runId,
          sessionId: "question-session",
          sessionKey: requestParams.sessionKey,
          timeoutMs: 60_000,
          operationalRunInstance: requesterAuthority.operationalRunInstance,
        });
        registration.bindAgentRunDelegatedAuthority(requesterAuthority);
        // Projection cleanup is not an abort; exercise the owner that revokes
        // the exact claim before notifying the run's abort listeners.
        try {
          expect(
            abortChatRunById(
              {
                chatAbortControllers,
                chatRunState: createChatRunState(),
                removeChatRun: () => undefined,
                agentRunSeq: new Map(),
                broadcast: vi.fn(),
                nodeSendToSession: vi.fn(),
              },
              { runId: requestParams.runId, sessionKey: requestParams.sessionKey },
            ),
          ).toEqual({ aborted: true });
        } finally {
          registration.cleanup();
        }
      }
      try {
        if (closure !== "abort") {
          expect(getAgentRunContext(requestParams.runId)).toBeDefined();
        }
        const resolved = await answerSecret(id, "test-secret-stale-requester");
        expect(resolved).toMatchObject(invalidRequest);
        expect(await listSecrets()).toEqual([]);
        expect(reloadSecrets).not.toHaveBeenCalled();
        expect(manager.get(id)?.status).toBe("cancelled");
        await expect(waiting).resolves.toEqual({ status: "cancelled" });
        await manager.drain();
        published("question.resolved", { id, status: "cancelled" });
        expect((await call("question.resolve", { id: ordinaryId, answers: homeAnswers }))[0]).toBe(
          true,
        );
        if (successor) {
          const successorClient = {
            ...adminRequestClient,
            internal: {
              agentRuntimeIdentity: {
                ...adminRequestClient.internal!.agentRuntimeIdentity!,
                operationalRunInstance: successor.operationalRunInstance,
                delegatedAuthority: { kind: "local", ...successor },
              },
            },
          } as GatewayClient;
          const replacement = await call("question.request", secretRequestParams, {
            client: successorClient,
          });
          const replacementId = (replacement[1] as { id: string }).id;
          expect((await answerSecret(replacementId, "test-secret-current-requester"))[0]).toBe(
            true,
          );
          expect(await readSecret()).toEqual({
            ok: true,
            value: "test-secret-current-requester",
          });
        }
      } finally {
        if (successor) {
          releaseAgentRunDelegatedAuthority(successor);
        }
      }
    });
  },
);

it("requires admitted authority, not an admin's supplied run metadata", async () => {
  expect(
    await call("question.request", secretRequestParams, {
      client: { connect: { scopes: ["operator.admin"] } } as GatewayClient,
    }),
  ).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
});

it("diverts operator-entered credentials into the store and exposes only a stored marker", async () => {
  await withState(async () => {
    const id = await requestSecretQuestion();
    const value = "test-secret-value-gateway-diversion-123";
    const client = {
      connect: { client: { displayName: "Trusted Operator" }, scopes: ["operator.questions"] },
    } as GatewayClient;

    const resolved = await call(
      "question.resolve",
      { id, answers: secretAnswers(value), resolvedBy: "control-ui" },
      { client },
    );

    expect(resolved).toEqual(ok(answered()));
    expect(await listSecrets()).toMatchObject([
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.test"],
        updatedBy: "Trusted Operator",
      },
    ]);
    expect(manager.get(id)).toMatchObject(answered());
    expect(await call("question.waitAnswer", { id })).toEqual(ok(answered()));
    await manager.drain();
    published("question.resolved", { id, status: "answered", answers: storedAnswers });
    expect(JSON.stringify([resolved, manager.get(id), broadcast.mock.calls])).not.toContain(value);
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  });
});

it("uses operator-edited hosts and keeps invalid store submissions pending for retry", async () => {
  await withState(async () => {
    const id = await requestSecretQuestion();
    const value = "test-secret-value-retry-123";
    const invalid = await answerSecret(id, value, { secretStoreAllowedHosts: ["*.example.test"] });
    expect(invalid).toMatchObject(
      failure({ code: "INVALID_REQUEST", message: expect.stringContaining("wildcard") }),
    );
    expect(manager.get(id)?.status).toBe("pending");
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);

    const retried = await answerSecret(id, value, {
      secretStoreAllowedHosts: ["replacement.example.test"],
    });
    expect(retried[0]).toBe(true);
    expect((await listSecrets())[0]).toMatchObject({
      allowedHosts: ["replacement.example.test"],
    });
  });
});

it.each<[string, Record<string, string[]>, string | undefined]>([
  ["no submitted value", { secret_value: [] }, undefined],
  [
    "an unrelated submitted answer",
    { secret_value: ["test-secret-value-only"], destination: ["Home"] },
    undefined,
  ],
  [
    "an unavailable write service",
    { secret_value: ["test-secret-value-unavailable-123"] },
    "database unavailable",
  ],
])("keeps a secret question pending with %s", async (_name, answers, error) => {
  await withState(async () => {
    if (error) {
      vi.spyOn(storeWriteService, "write").mockImplementation(() => {
        throw new Error(error);
      });
    }
    const id = await requestSecretQuestion();
    expect(await call("question.resolve", { id, answers: { answers } })).toMatchObject(
      failure({ code: error ? "UNAVAILABLE" : "INVALID_REQUEST" }),
    );
    expect(manager.get(id)?.status).toBe("pending");
    expect(await listSecrets()).toEqual([]);
  });
});

it("rejects masked env requests while preserving ordinary question host validation and cancellation", async () => {
  await withState(async () => {
    expect(
      await requestQuestions(
        [secretQuestion({ secretStore: { name: "SERVICE_URL", kind: "env" } })],
        adminRequestClient,
      ),
    ).toMatchObject(invalidRequest);
    expect(manager.list()).toEqual([]);
    expect(await listSecrets()).toEqual([]);
    const ordinaryResponse = await call("question.request", requestParams);
    const ordinaryId = (ordinaryResponse[1] as { id: string }).id;
    expect(
      await call("question.resolve", {
        id: ordinaryId,
        answers: homeAnswers,
        secretStoreAllowedHosts: ["example.test"],
      }),
    ).toMatchObject(invalidRequest);
    expect(manager.get(ordinaryId)?.status).toBe("pending");
    const id = await requestSecretQuestion();
    expect(await call("question.resolve", { id, cancel: true })).toEqual(
      ok({ status: "cancelled" }),
    );
  });
});

it("settles the SQLite commit before a second answer races its deferred refresh", async () => {
  await withState(async () => {
    mockReferencedStoreSnapshot();
    const reload = createDeferred<{ warningCount: number }>();
    const reloadStarted = createDeferred();
    reloadSecrets.mockImplementation(() => {
      reloadStarted.resolve();
      return reload.promise;
    });
    const id = await requestSecretQuestion();
    const firstValue = "test-secret-committed-first";
    const pending = answerSecret(id, firstValue);
    const competitors: Array<ReturnType<typeof call>> = [];
    try {
      await Promise.race([
        reloadStarted.promise,
        pending.then(() => {
          throw new Error("Question resolve settled before entering its deferred refresh");
        }),
      ]);
      competitors.push(answerSecret(id, "test-secret-late-overwrite"));
      expect(await readSecret()).toEqual({ ok: true, value: firstValue });
      expect(manager.get(id)?.status).toBe("answered");
      expect(reloadSecrets).toHaveBeenCalledTimes(1);
      expect(reloadSecrets).toHaveBeenCalledWith({
        forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
        joinInFlight: false,
      });
    } finally {
      reload.resolve({ warningCount: 0 });
      await Promise.all([pending, ...competitors]);
    }
    expect((await pending)[0]).toBe(true);
    for (const competitor of competitors) {
      expect((await competitor)[0]).toBe(false);
    }
    expect(await manager.waitAnswer(id)).toEqual(answered());
  });
});

it("keeps a committed answer terminal and reports refresh failure without inviting overwrite", async () => {
  await withState(async () => {
    mockReferencedStoreSnapshot();
    reloadSecrets.mockRejectedValue(new Error("synthetic refresh failure"));
    const id = await requestSecretQuestion();
    const value = "test-secret-refresh-failed";
    const resolutionId = "committed-before-refresh";
    const result = await answerSecret(id, value, { resolutionId });
    expect(result).toMatchObject(
      failure({ code: "UNAVAILABLE", message: expect.stringContaining("was saved") }),
    );
    expect(manager.get(id)?.status).toBe("answered");
    expect(await manager.waitAnswer(id)).toEqual(answered());
    expect(await call("question.waitAnswer", { id, includeResolutionId: true })).toEqual(
      ok({ status: "answered", answers: storedAnswers, resolutionId }),
    );
    expect((await answerSecret(id, "test-secret-overwrite"))[0]).toBe(false);
    expect(await readSecret()).toEqual({ ok: true, value });
    expect(reloadSecrets).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, manager.get(id), broadcast.mock.calls])).not.toContain(value);
  });
});

it("returns INVALID_REQUEST for answers that violate the stored question", async () => {
  const requested = await requestQuestions([
    makeQuestion({ options: [{ label: "Home" }, { label: "Office" }], isOther: false }),
  ]);
  const id = (requested[1] as { id: string }).id;

  const resolved = await call("question.resolve", {
    id,
    answers: { answers: { destination: ["Somewhere else"] } },
  });

  expect(resolved).toMatchObject(
    failure({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("question 'destination'"),
      details: { reason: "QUESTION_INVALID_ANSWER" },
    }),
  );
  expect(manager.get(id)?.status).toBe("pending");
});

it.each<[string, boolean, string[] | undefined, string[] | undefined, string[]]>([
  ["concurrent creation", false, undefined, undefined, []],
  ["concurrent host update", true, undefined, undefined, ["a.example.test"]],
  ["empty proposed policy", true, [], undefined, []],
  ["operator clears policy", true, undefined, [], ["a.example.test"]],
])(
  "saves only the consented host policy: %s",
  async (_scenario, existing, proposal, override, shown) => {
    await withState(async () => {
      const entry = {
        scope: { kind: "team" as const },
        name: "SERVICE_API_KEY",
        kind: "secret" as const,
        value: "test-secret-existing",
        updatedBy: "Previous Operator",
      };
      if (existing) {
        await writeSecretStoreEntry({ ...entry, allowedHosts: ["a.example.test"] });
      }
      const id = await requestSecretQuestion({
        name: entry.name,
        kind: entry.kind,
        ...(proposal !== undefined ? { allowedHosts: proposal } : {}),
      });
      const question = {
        secretStore: { name: entry.name, kind: entry.kind, allowedHosts: shown },
        ...(existing
          ? { secretStoreExisting: { updatedAtMs: 1_000, updatedBy: entry.updatedBy } }
          : {}),
      };
      const displayed = await call("question.get", { id });
      expect(displayed).toMatchObject(ok({ question: { questions: [question] } }));
      expect(JSON.stringify(displayed)).not.toContain(entry.value);
      published(
        "question.requested",
        expect.objectContaining({ id, questions: [expect.objectContaining(question)] }),
      );
      if (!existing) {
        expect(manager.get(id)?.questions[0]).not.toHaveProperty("secretStoreExisting");
      }
      await writeSecretStoreEntry({ ...entry, allowedHosts: ["b.example.test"] });
      expect((await listSecrets())[0]?.allowedHosts).toEqual(["b.example.test"]);
      const value = "test-secret-consented-replacement";
      const resolved = await call("question.resolve", {
        id,
        answers: secretAnswers(value),
        ...(override !== undefined ? { secretStoreAllowedHosts: override } : {}),
      });
      expect(resolved).toEqual(ok(answered()));
      expect(manager.get(id)).toMatchObject(answered());
      expect(await listSecrets()).toMatchObject([
        { name: entry.name, kind: "secret", allowedHosts: override ?? shown },
      ]);
      expect(await readSecret()).toEqual({ ok: true, value });
    });
  },
);
