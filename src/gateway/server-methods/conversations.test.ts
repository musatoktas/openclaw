import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import { runGatewayConversationList } from "../conversation-list.js";
import { runGatewayConversationSend } from "../conversation-send.js";
import { runGatewayConversationTurn } from "../conversation-turn.js";
import { conversationHandlers } from "./conversations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

vi.mock("../../sessions/conversation-turns.js", () => ({ cancelPendingConversationTurn: vi.fn() }));
vi.mock("../conversation-list.js", () => ({ runGatewayConversationList: vi.fn() }));
vi.mock("../conversation-send.js", () => ({ runGatewayConversationSend: vi.fn() }));
vi.mock("../conversation-turn.js", () => ({ runGatewayConversationTurn: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

const request = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  turnId: "conversation-turn-1",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "hello molty",
  timeoutMs: 30_000,
};

const result = {
  status: "replied" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  correlationPersisted: true,
  reply: {
    conversationRef: request.conversationRef,
    messageId: "reef-inbound-1",
    replyToId: "reef-outbound-1",
    text: "hello clawd",
    timestamp: 300,
  },
};

const sendRequest = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  operationId: "conversation-send-1",
  conversationRef: request.conversationRef,
  message: "hello molty",
};

const sendResult = {
  status: "sent" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  queueId: "conversation-send-1",
};

const adminClient = {
  connect: { scopes: ["operator.admin"] },
} as never;

function context(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

function caller(
  method = "conversations.turn",
  defaults: Record<string, unknown> = request,
  client: GatewayClient | null = adminClient,
) {
  const gatewayContext = context();
  return {
    gatewayContext,
    invoke: (respond: RespondFn, params = defaults) =>
      conversationHandlers[method]!({
        params,
        respond,
        context: gatewayContext,
        req: { type: "req", id: "1", method },
        client,
        isWebchatConnect: () => false,
      }),
  };
}

function expectFailure(
  respond: RespondFn,
  error: { code: string; message?: string } = { code: "INVALID_REQUEST" },
  ...meta: unknown[]
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error), ...meta);
}

function expectReply(
  respond: RespondFn,
  payload = result,
  meta: Record<string, unknown> = { channel: "reef" },
) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined, meta);
}

describe("conversations.list Gateway handler", () => {
  it("runs discovery and listing inside the Gateway runtime", async () => {
    const listed = {
      conversations: [
        {
          conversationRef: request.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct" as const,
          target: "reef:molty",
          firstSeenAt: 100,
          lastSeenAt: 100,
        },
      ],
    };
    const runConversationList = vi.mocked(runGatewayConversationList).mockResolvedValue(listed);
    const { invoke } = caller("conversations.list", {
      agentId: "main",
      channel: "reef",
      query: "@molty",
      limit: 50,
    });
    const respond = vi.fn<RespondFn>();

    await invoke(respond);

    expect(runConversationList).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.any(Object),
        agentId: "main",
        channel: "reef",
        query: "@molty",
        limit: 50,
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, listed, undefined);
  });

  it("rejects invalid limits before directory discovery", async () => {
    const runConversationList = vi.mocked(runGatewayConversationList);
    const { invoke } = caller("conversations.list");
    const respond = vi.fn<RespondFn>();

    await invoke(respond, { agentId: "main", channel: "reef", limit: 101 });

    expect(runConversationList).not.toHaveBeenCalled();
    expectFailure(respond);
  });
});

describe("conversations.send Gateway handler", () => {
  it("owns the send and rejects operation-id reuse with different source input", async () => {
    const runConversationSend = vi.mocked(runGatewayConversationSend).mockResolvedValue(sendResult);
    const { invoke } = caller("conversations.send", sendRequest);
    const respond = vi.fn<RespondFn>();

    await invoke(respond);
    expect(runConversationSend).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "conversation-send-1",
        conversationRef: request.conversationRef,
        message: "hello molty",
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });

    const mismatchRespond = vi.fn<RespondFn>();
    await invoke(mismatchRespond, {
      ...sendRequest,
      sourceSessionKey: "agent:main:discord:channel:other",
    });
    expect(runConversationSend).toHaveBeenCalledOnce();
    expectFailure(mismatchRespond);
  });
});

describe("conversations.turn Gateway handler", () => {
  it("rejects a source session owned by another agent", async () => {
    const runConversationTurn = vi.mocked(runGatewayConversationTurn);
    const { invoke } = caller();
    const respond = vi.fn<RespondFn>();

    await invoke(respond, { ...request, sourceSessionKey: "agent:ops:main" });

    expectFailure(respond, { code: "INVALID_REQUEST", message: expect.stringContaining("ops") });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("validates requests before entering the correlation service", async () => {
    const runConversationTurn = vi.mocked(runGatewayConversationTurn);
    const { invoke } = caller();
    const respond = vi.fn<RespondFn>();

    await invoke(respond, { agentId: "main" });

    expectFailure(respond);
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("joins concurrent retries and replays the completed idempotent result", async () => {
    const pending = createDeferred<typeof result>();
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockReturnValue(pending.promise);
    const { invoke, gatewayContext } = caller();
    const firstRespond = vi.fn<RespondFn>();
    const secondRespond = vi.fn<RespondFn>();
    const first = invoke(firstRespond);
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());
    expect(runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    const timeoutMismatchRespond = vi.fn<RespondFn>();
    await invoke(timeoutMismatchRespond, { ...request, timeoutMs: 5_000 });
    expectFailure(timeoutMismatchRespond);
    const second = invoke(secondRespond);
    pending.resolve(result);
    await Promise.all([first, second]);

    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectReply(firstRespond);
    expectReply(secondRespond, result, { channel: "reef", cached: true });

    const cachedRespond = vi.fn<RespondFn>();
    await invoke(cachedRespond);
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(cachedRespond).toHaveBeenCalledWith(true, result, undefined, { cached: true });

    for (const key of gatewayContext.dedupe.keys()) {
      if (key.endsWith(":identity")) {
        gatewayContext.dedupe.delete(key);
      }
    }
    const mismatchedRespond = vi.fn<RespondFn>();
    await invoke(mismatchedRespond, { ...request, message: "different message" });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectFailure(mismatchedRespond);
  });

  it("keeps concurrent turn IDs isolated between agents", async () => {
    const pending = createDeferred<typeof result>();
    const otherResult = { ...result, messageId: "reef-outbound-other" };
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockImplementation(async ({ agentId }: Parameters<typeof runGatewayConversationTurn>[0]) =>
        agentId === "main" ? await pending.promise : otherResult,
      );
    const { invoke } = caller();
    const firstRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();
    const first = invoke(firstRespond);
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());

    const other = invoke(otherRespond, {
      ...request,
      agentId: "other-agent",
      sourceSessionKey: "agent:other-agent:telegram:direct:operator",
    });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledTimes(2));
    pending.resolve(result);
    await Promise.all([first, other]);

    expectReply(firstRespond);
    expectReply(otherRespond, otherResult);
  });

  it("retries transient unavailable failures instead of caching them", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce(result);
    const { invoke } = caller();
    const failedRespond = vi.fn<RespondFn>();

    await invoke(failedRespond);
    expectFailure(failedRespond, { code: "UNAVAILABLE" }, expect.any(Object));

    const retryRespond = vi.fn<RespondFn>();
    await invoke(retryRespond);
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expectReply(retryRespond);
  });

  it("does not let a durable operation conflict poison the authoritative retry identity", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockRejectedValueOnce(
        new ConversationOperationConflictError(
          `Conversation delivery operation was reused with different input: ${request.turnId}`,
        ),
      )
      .mockResolvedValueOnce(result);
    const { invoke, gatewayContext } = caller();
    const conflictRespond = vi.fn<RespondFn>();

    await invoke(conflictRespond, { ...request, message: "conflicting message" });
    expectFailure(conflictRespond, { code: "INVALID_REQUEST" }, expect.any(Object));
    expect([...gatewayContext.dedupe.keys()].some((key) => key.endsWith(":identity"))).toBe(false);

    const authoritativeRespond = vi.fn<RespondFn>();
    await invoke(authoritativeRespond);
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expectReply(authoritativeRespond);
  });

  it("maps unsupported conversation input to a stable invalid-request response", async () => {
    const runConversationTurn = vi
      .mocked(runGatewayConversationTurn)
      .mockRejectedValue(
        new ConversationInputError("Channel matrix does not support correlated turns"),
      );
    const { invoke } = caller();
    const respond = vi.fn<RespondFn>();

    await invoke(respond);

    const error = {
      code: "INVALID_REQUEST",
      message: "Channel matrix does not support correlated turns",
    };
    expectFailure(respond, error, expect.any(Object));

    const retryRespond = vi.fn<RespondFn>();
    await invoke(retryRespond);
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectFailure(retryRespond, error, { cached: true });
  });

  it("cancels an abandoned turn through the active Gateway connection", async () => {
    const cancelConversationTurn = vi.mocked(cancelPendingConversationTurn).mockReturnValue(true);
    const { invoke } = caller(
      "conversations.turn.cancel",
      {
        agentId: request.agentId,
        turnId: request.turnId,
      },
      null,
    );
    const respond = vi.fn<RespondFn>();

    await invoke(respond);

    expect(cancelConversationTurn).toHaveBeenCalledWith({
      agentId: request.agentId,
      id: request.turnId,
    });
    expect(respond).toHaveBeenCalledWith(true, { cancelled: true }, undefined);
  });
});
