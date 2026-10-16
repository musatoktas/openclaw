import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import type { VerifySetupInferenceResult } from "./setup-inference.js";

const runtime = {} as RuntimeEnv;

function route(agentId: string, provider: string): SystemAgentConfiguredRoute {
  return {
    runner: "embedded",
    agentHarnessRuntimeOverride: "openclaw",
    runConfig: {},
    sourceConfig: {},
    modelLabel: `${provider}/model`,
    provider,
    model: "model",
    agentDir: `/tmp/${agentId}`,
    agentId,
  };
}

function fallbackConfig(
  primary: string,
  entries: Record<string, string>,
  systemAgent?: { agentId: string },
): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary }, ...(systemAgent ? { systemAgent } : {}) },
      entries: Object.fromEntries(Object.entries(entries).map(([id, model]) => [id, { model }])),
    },
  };
}

async function verifyAfterFailure(
  failure: Extract<VerifySetupInferenceResult, { ok: false }>,
  {
    includeBeta = false,
    successfulAgentId = "alpha-other",
  }: { includeBeta?: boolean; successfulAgentId?: "alpha-other" | "beta" } = {},
) {
  const attempts: string[] = [];
  const cfg = fallbackConfig("alpha/model", {
    requester: "alpha/model",
    "alpha-other": "alpha/model",
    ...(includeBeta ? { beta: "beta/model" } : {}),
  });
  const result = await verifySystemAgentInferenceWithFallback({
    requestingAgentId: "requester",
    runtime,
    deps: {
      readConfig: async () => cfg,
      resolveRoute: async (_cfg, agentId) => route(agentId, agentId === "beta" ? "beta" : "alpha"),
      hasAuth: async () => true,
      verify: async ({ agentId }) => {
        attempts.push(agentId);
        return agentId === successfulAgentId
          ? ({
              ok: true,
              modelRef: agentId === "beta" ? "beta/model" : "alpha/model",
              latencyMs: 1,
              binding: {},
            } as never)
          : { ...failure };
      },
    },
  });
  return { result, attempts };
}

describe("system-agent inference fallback", () => {
  it("does not claim providers are unconfigured when no route can be verified", async () => {
    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      deps: {
        readConfig: async () => ({}),
        resolveRoute: async () => null,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
    });
  });

  it("tries the system-agent route first, then authenticated providers by provider id", async () => {
    const attempts: string[] = [];
    const verify = vi.fn(async ({ agentId }: { agentId: string }) => {
      attempts.push(agentId);
      return agentId === "beta"
        ? ({ ok: true, modelRef: "beta/model", latencyMs: 1, binding: {} } as never)
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });

    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      deps: {
        readConfig: async () => config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async () => true,
        verify: verify as never,
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha", "beta"]);
  });

  it("retains the implicit main fallback for a pre-roster config", async () => {
    const attempts: string[] = [];
    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => ({}),
        resolveRoute: async (_cfg, agentId) => route(agentId, agentId),
        hasAuth: async () => true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "main"
            ? ({ ok: true, modelRef: "main/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "unavailable", error: "down" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "main"]);
  });

  it("skips unauthenticated fallback providers", async () => {
    const attempts: string[] = [];
    await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async ({ provider }) => provider !== "alpha",
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return { ok: false, status: "unavailable", error: "down" };
        },
      },
    });

    expect(attempts).toEqual(["requester", "beta"]);
  });

  it("uses a later authenticated route for one fallback provider", async () => {
    const attempts: string[] = [];
    const duplicateProviderConfig = fallbackConfig("zeta/model", {
      requester: "zeta/model",
      "alpha-bad": "alpha/model",
      "alpha-good": "alpha/model",
    });

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => duplicateProviderConfig,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : "alpha"),
        hasAuth: async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "alpha-good"
            ? ({ ok: true, modelRef: "alpha/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "unavailable", error: "down" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-good"]);
  });

  it.each([
    ["auth", "stale key", false, "alpha-other"],
    ["rate_limit", "429", false, "alpha-other"],
    ["format", "bad response", true, "alpha-other"],
    ["unavailable", "down", true, "beta"],
  ] as const)(
    "retries %s at the correct owner scope",
    async (status, error, includeBeta, successfulAgentId) => {
      const { result, attempts } = await verifyAfterFailure(
        { ok: false, status, error },
        { includeBeta, successfulAgentId },
      );
      expect(result.ok).toBe(true);
      expect(attempts).toEqual(["requester", successfulAgentId]);
    },
  );

  it("does not fail over on owner or identity uncertainty", async () => {
    const verify = vi.fn(
      async () => ({ ok: false, status: "unknown", error: "winner identity uncertain" }) as const,
    );

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () =>
          fallbackConfig(
            "zeta/model",
            { requester: "zeta/model", beta: "beta/model", alpha: "alpha/model" },
            { agentId: "requester" },
          ),
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async () => true,
        verify,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "winner identity uncertain",
    });
    expect(verify).toHaveBeenCalledOnce();
  });
});
