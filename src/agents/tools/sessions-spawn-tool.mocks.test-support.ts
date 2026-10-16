import { vi } from "vitest";
import { hoisted } from "./sessions-spawn-runtime.mocks.test-support.js";

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: (...args: unknown[]) => hoisted.registerSubagentRunMock(...args),
}));

vi.mock("./in-process-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./in-process-gateway.js")>();
  return {
    ...actual,
    callInProcessGatewayToolWithCreation: (...args: unknown[]) =>
      hoisted.inProcessCreationMock(...args),
  };
});

export { hoisted };
