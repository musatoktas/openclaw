import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const lifetime = createFixtureLifetime();
const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("./tools-stdio-server.lifecycle.fixture.mjs", import.meta.url),
);
afterAll(() => lifetime.cleanup());

// Registration/disposal depth is owned by plugin-tools-registration.stdio.test.ts.
// This matrix protects the real stdio boundary and both generations of SDK peer.
describe("tools MCP stdio lifecycle", () => {
  it.for([
    ["v1", "EOF", "client"],
    ["v1", "SIGINT", "client"],
    ["v1", "SIGTERM", "client"],
    ["v2", "EOF", "client"],
    ["v2", "SIGINT", "client"],
    ["v2", "SIGTERM", "client"],
    ["v2", "EOF", "worker"],
  ] as const)(
    "%s %s (%s): settles real subprocess shutdown",
    async ([version, shutdown, role], { signal }) => {
      await lifetime.run(async () => {
        const root = lifetime.createTempDir("openclaw-mcp-stdio-");
        const result = await runNodeScript(
          [fixture, role, version, shutdown, root],
          { PATH: process.env.PATH },
          undefined,
          {
            cwd: repository,
            signal,
            executable: process.execPath,
            requireProcessTreeExit: true,
            maxBuffer: 1024 * 1024,
          },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          version,
          shutdown,
          worker: role === "worker",
        });
      });
    },
  );
});
