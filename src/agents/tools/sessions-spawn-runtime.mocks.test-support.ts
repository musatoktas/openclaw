import { vi } from "vitest";
import type { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

export const hoisted = vi.hoisted(() => ({
  spawnSubagentDirectMock: vi.fn(),
  spawnAcpDirectMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  inProcessCreationMock: vi.fn(),
  runSubagentProgressMock: vi.fn(async () => {}),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
}));

vi.mock("../subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: hoisted.prepareModelChoiceMock,
}));
vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));
vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "subagent_progress",
    runSubagentProgress: hoisted.runSubagentProgressMock,
  }),
}));
