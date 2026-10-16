import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  uuid: "00000000-0000-4000-8000-000000000188",
  entries: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => fixture.uuid,
}));
vi.mock("../../src/plugin-state/plugin-state-store.ts", () => ({
  createPluginStateKeyedStore: () => ({ entries: fixture.entries }),
}));

const originalArgv = process.argv;
const smokeId = `acp-smoke-${fixture.now}-00000000`;
const ackToken = `ACP_SMOKE_ACK_${smokeId}`;
const binding = {
  threadId: "thread",
  targetSessionKey: "agent:codex:acp:synthetic",
  targetKind: "acp",
  agentId: "codex",
  boundAt: fixture.now,
};

afterEach(() => {
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Request = [method: string, path: string, authorization: string | null, body: unknown];
const webhook = "/webhooks/webhook/synthetic-webhook";
const jsonOutput = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function runDriver(driver: "token" | "webhook", failure?: "identity" | "send") {
  vi.resetModules();
  fixture.entries.mockReset().mockResolvedValue([{ value: binding }]);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(fixture.now);
  const sender = driver === "token" ? "driver-user" : "webhook-user";
  const auth = `Bot synthetic-${driver === "token" ? "driver" : "bot"}`;
  const refusal = () =>
    Response.json({ message: "synthetic refusal" }, { status: 403, statusText: "Forbidden" });
  const exchanges: Array<[Request, Response]> = [
    [
      ["GET", "/users/@me", auth, undefined],
      failure === "identity" ? refusal() : Response.json({ id: "driver-user" }),
    ],
  ];
  if (failure !== "identity") {
    if (driver === "webhook") {
      exchanges.push([
        ["POST", "/channels/parent/webhooks", auth, { name: "openclaw-acp-smoke-00000000" }],
        Response.json({ id: "webhook", token: "synthetic-webhook" }),
      ]);
    }
    exchanges.push([
      [
        "POST",
        driver === "token" ? "/channels/parent/messages" : `${webhook}?wait=true`,
        driver === "token" ? auth : null,
        {
          content: "<@mentioned-user> Synthetic ACP instruction",
          allowed_mentions: { parse: [], users: ["mentioned-user"] },
        },
      ],
      failure === "send" ? refusal() : Response.json({ id: "sent", author: { id: sender } }),
    ]);
    if (failure !== "send") {
      exchanges.push([
        ["GET", "/channels/thread/messages?limit=50", auth, undefined],
        Response.json([
          { id: "sender-copy", author: { id: sender }, content: ackToken },
          { id: "ack", author: { id: "agent-user", username: "Agent" }, content: ackToken },
        ]),
      ]);
    }
    if (driver === "webhook") {
      exchanges.push([["DELETE", webhook, null, undefined], new Response(null, { status: 204 })]);
    }
  }
  const expectedRequests = exchanges.map(([request]) => request);
  const actualRequests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const incoming = new globalThis.Request(input, init);
      const url = new URL(incoming.url);
      const exchange = exchanges.shift();
      expect(exchange, "unexpected Discord request").toBeDefined();
      actualRequests.push([
        incoming.method,
        `${url.pathname}${url.search}`.replace(/^\/api\/v10/u, ""),
        incoming.headers.get("Authorization"),
        incoming.body === null ? undefined : await incoming.json(),
      ]);
      return exchange![1];
    }),
  );
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exited = new Error("synthetic process exit");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  process.argv = [
    process.execPath,
    path.resolve("scripts/dev/discord-acp-plain-language-smoke.ts"),
    ...Object.entries({
      channel: "parent",
      driver,
      token: "synthetic-driver",
      "bot-token": "synthetic-bot",
      "token-prefix": "Bot",
      "bot-token-prefix": "Bot",
      agent: "codex",
      mention: "mentioned-user",
      instruction: "Synthetic ACP instruction",
    }).flatMap(([flag, value]) => [`--${flag}`, value]),
    "--json",
  ];
  await expect(import("../../scripts/dev/discord-acp-plain-language-smoke.ts")).rejects.toBe(
    exited,
  );
  expect(exit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(exchanges).toEqual([]);
  // Assert after main returns so its API-error handling cannot swallow a mismatch.
  expect(actualRequests).toEqual(expectedRequests);
  return {
    exitCode: exit.mock.calls[0]?.[0],
    stdout: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
  };
}

it.each([
  ["token", undefined],
  ["webhook", undefined],
  ["token", "identity"],
  ["webhook", "identity"],
  ["webhook", "send"],
] as const)(
  "%s driver completes or reports %s failure and cleans up owned webhooks",
  async (driver, failure) => {
    const result = await runDriver(driver, failure);
    expect(result).toMatchObject({ exitCode: failure ? 1 : 0, stderr: "" });
    if (!failure) {
      expect(result.stdout).toBe(
        jsonOutput({
          ok: true,
          smokeId,
          ackToken,
          sentMessageId: "sent",
          binding,
          ackMessage: {
            id: "ack",
            authorId: "agent-user",
            authorUsername: "Agent",
            content: ackToken,
          },
        }),
      );
    } else {
      const expected = {
        ok: false,
        stage: failure === "identity" ? "discord-api" : "send-message",
        smokeId,
      };
      if (failure === "identity") {
        expect(JSON.parse(result.stdout)).toEqual({
          ...expected,
          error:
            'Discord API GET /users/@me failed: 403 Forbidden :: {"message":"synthetic refusal"}',
        });
      } else {
        expect(JSON.parse(result.stdout)).toMatchObject(expected);
      }
      expect(fixture.entries).not.toHaveBeenCalled();
    }
  },
);
