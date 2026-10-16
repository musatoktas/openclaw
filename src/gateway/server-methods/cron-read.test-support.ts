import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronHandlers } from "./cron.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export function createReadService(
  options: Omit<ConstructorParameters<typeof CronService>[0], "scheduler" | "nowMs" | "log">,
) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    log: createNoopLogger(),
    ...options,
  });
}

export async function callCron(
  context: GatewayRequestHandlerOptions["context"],
  method: string,
  params: Record<string, unknown>,
  options: Partial<Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">> = {},
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    cronHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method, params },
    params,
    context,
    client: null,
    respond,
    isWebchatConnect: () => false,
    ...options,
  });
  return respond;
}
