import { afterEach, beforeEach, expect, vi } from "vitest";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import { prepareSystemAgentRunAdmission as prepareRun } from "../../agents/admitted-run-context.js";
import { createAdmittedGatewayToolCallerIdentity as createCaller } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { QuestionManager } from "../question-manager.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
  RespondFn,
} from "./types.js";

export let manager: QuestionManager;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
export let requesterAuthority: AgentRunDelegatedAuthority;
let unregisterAuthorityClosed: () => void;
export let adminRequestClient: GatewayClient;
export let broadcast: ReturnType<typeof vi.fn<GatewayBroadcastFn>>;
export let storeWriteService: ReturnType<typeof createSecretStoreWriteService>;
let handlers: ReturnType<typeof createQuestionHandlers>;
type SecretStoreReload = Parameters<typeof createSecretStoreWriteService>[0]["reloadSecrets"];
export let reloadSecrets: ReturnType<typeof vi.fn<SecretStoreReload>>;

export const questionNotFound = [false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }];
export const questionOk = (value: unknown) => [true, value, undefined];
export const questionError = (error: unknown) => [false, undefined, error];

export async function createQuestionSource(
  client: GatewayClient,
  cfg: OpenClawConfig,
  viaClient = false,
  context: Parameters<typeof captureGatewayOperatorRunAuthority>[0]["context"] = {
    getRuntimeConfig: () => cfg,
  },
) {
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  if (viaClient) {
    client.internal = { ...client.internal, operatorAccessAuthority: authority };
  }
  const source = await captureGatewayOperatorRunAuthority({
    client,
    context,
    ...(viaClient ? {} : { sourceAuthority: authority }),
  });
  if (!source) {
    throw new Error("Expected admitted question source");
  }
  return { source, controller };
}

type QuestionSend = (
  wire: string | Buffer,
  options?: { binary: false } | ((error?: Error) => void),
  callback?: (error?: Error) => void,
) => void;

export function createQuestionPeer(
  client: GatewayClient,
  connId: string,
  send = vi.fn<QuestionSend>(),
) {
  const socket = { readyState: 1, bufferedAmount: 0, send, close: vi.fn() };
  const ws: GatewayWsClient = {
    ...client,
    authenticatedUserProfile: client.authenticatedUserProfile
      ? {
          ...client.authenticatedUserProfile,
          avatarRevision: client.authenticatedUserProfile.avatarRevision ?? "",
        }
      : undefined,
    connId,
    usesSharedGatewayAuth: false,
    socket: socket as unknown as GatewayWsClient["socket"],
  };
  return { ws, socket, send };
}

export function observeQuestionWait(once = true) {
  const entered = createDeferredCore();
  const wait = manager.waitAnswer.bind(manager);
  const observe = (...args: Parameters<typeof wait>) => {
    const result = wait(...args);
    entered.resolve();
    return result;
  };
  const spy = vi.spyOn(manager, "waitAnswer");
  if (once) {
    spy.mockImplementationOnce(observe);
  } else {
    spy.mockImplementation(observe);
  }
  return { entered: entered.promise, spy };
}

export function createProjectedQuestionBroadcaster(
  cfg: OpenClawConfig,
  projection: SessionRowProjection,
  clients: GatewayClientRegistry,
) {
  return createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({
        cfg,
        client,
        sessionKeys,
        agentId,
        event,
        payload,
        prepared: {
          sharing: prepareProjectedSessionSharing({
            cfg,
            client,
            isMember: (target, identityId) =>
              projection.hasMembership(target.storePath, target.storeKey, identityId),
          }),
          target: (key, targetAgentId) => {
            const { agentId: ownerAgentId } = resolveSessionStoreIdentity({
              cfg,
              sessionKey: key,
              agentId: targetAgentId,
            });
            return projection.sharingTarget({ key, agentId: ownerAgentId });
          },
        },
      }),
  });
}

export function installQuestionTestHooks() {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    // Keep projection metadata alive independently of the exact admitted authority.
    registerAgentRunContext(requestParams.runId, {
      sessionKey: requestParams.sessionKey,
      agentId: requestParams.agentId,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    scheduler = createTestGatewayScheduler("fake-timers");
    manager = new QuestionManager(scheduler);
    requesterAuthority = claimAgentRunDelegatedAuthority({
      instanceId: "requester-instance",
      runId: requestParams.runId,
    });
    adminRequestClient = createQuestionRuntimeClient(requesterAuthority, requestParams);
    unregisterAuthorityClosed = registerAgentRunDelegatedAuthorityClosedHandler((authority) =>
      manager.cancelClosedAuthorities(authority.operationalRunInstance),
    );
    broadcast = vi.fn<GatewayBroadcastFn>();
    reloadSecrets = vi.fn<SecretStoreReload>().mockResolvedValue({ warningCount: 0 });
    storeWriteService = createSecretStoreWriteService({ reloadSecrets });
    handlers = createQuestionHandlers(manager, storeWriteService, scheduler);
  });

  afterEach(async () => {
    releaseAgentRunDelegatedAuthority(requesterAuthority);
    unregisterAuthorityClosed();
    clearAgentRunContext(requestParams.runId);
    manager.close();
    await manager.drain();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

export async function callQuestionRpc(
  method: string,
  params: Record<string, unknown>,
  options?: { client?: GatewayClient; cfg?: OpenClawConfig; registered?: true } & Pick<
    GatewayRequestOptions,
    "hasCurrentClientAuthority"
  >,
) {
  const cfg = options?.cfg ?? {};
  const response = await invokeQuestionRpc(
    method,
    params,
    async (request) => {
      if (options?.registered) {
        const { handleGatewayRequest } = await import("../server-methods.js");
        await handleGatewayRequest({ ...request, extraHandlers: handlers });
      } else {
        await handlers[method]?.(request);
      }
    },
    {
      client: options?.client ?? null,
      hasCurrentClientAuthority: options?.hasCurrentClientAuthority,
      context: createDirectChatContext({
        broadcast,
        questionManager: manager,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
        getRuntimeConfig: () => cfg,
      }),
    },
    "request-1",
  );
  if (!response) {
    throw new Error(`expected ${method} response`);
  }
  return response;
}

export const requestParams = {
  questions: [
    {
      questionId: "destination",
      header: "Destination",
      question: "Where next?",
      options: [],
      multiSelect: false,
      isOther: true,
      isSecret: false,
    },
  ],
  agentId: "main",
  sessionKey: "agent:main:main",
  runId: "run-main",
  timeoutMs: 100,
};

export const secretRequestQuestion = {
  questionId: "secret_value",
  header: "API key",
  question: "Provide SERVICE_API_KEY",
  options: [],
  isSecret: true,
  secretStore: {
    name: "SERVICE_API_KEY",
    kind: "secret" as const,
    allowedHosts: ["api.example.test"],
  },
};

export const secretRequestParams = {
  ...requestParams,
  questions: [secretRequestQuestion],
};

export async function requestSecretQuestion(
  binding: NonNullable<QuestionRequestQuestion["secretStore"]> = secretRequestQuestion.secretStore,
): Promise<string> {
  const response = await callQuestionRpc(
    "question.request",
    {
      ...secretRequestParams,
      questions: [{ ...secretRequestQuestion, secretStore: binding }],
    },
    { client: adminRequestClient },
  );
  expect(response[0]).toBe(true);
  return (response[1] as { id: string }).id;
}

export function createQuestionRuntimeClient(
  claim: AgentRunDelegatedAuthority,
  { agentId, sessionKey }: { agentId: string; sessionKey: string } = requestParams,
  client = { connect: { scopes: ["operator.admin"] } } as GatewayClient,
): GatewayClient {
  return {
    ...client,
    internal: {
      ...client.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId,
        sessionKey,
        operationalRunInstance: claim.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...claim },
      },
    },
  };
}

export function createQuestionTestHandlers(
  questionManager: QuestionManager,
  clock: Parameters<typeof createQuestionHandlers>[2],
) {
  return createQuestionHandlers(
    questionManager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    clock,
  );
}

export async function invokeQuestionRpc(
  method: string,
  params: Record<string, unknown>,
  dispatch: (options: GatewayRequestHandlerOptions) => void | Promise<void>,
  options: Omit<GatewayRequestOptions, "req" | "respond" | "isWebchatConnect">,
  id = "request",
) {
  const responses: Parameters<RespondFn>[] = [];
  await dispatch({
    ...options,
    req: { type: "req", id, method, params },
    params,
    respond: (...args) => responses.push(args),
    isWebchatConnect: () => false,
  });
  return responses[0];
}

export async function admitQuestionRun(
  cfg: OpenClawConfig,
  runId: string,
  target: { agentId: string; sessionKey: string },
  label: string,
  authority?: Parameters<typeof prepareRun>[5],
  resolve?: Parameters<typeof bindGatewayContextResolver>[1],
) {
  const parent = prepareRun(cfg, runId, target.agentId, label, undefined, authority);
  const admitted = await parent.admit("embedded");
  if (resolve) {
    bindGatewayContextResolver(admitted, resolve);
  }
  const caller = createCaller({ admittedRunContext: admitted, ...target });
  return { parent, admitted, caller };
}
