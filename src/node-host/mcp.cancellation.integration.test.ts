import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { startNodeHostMcpManager } from "./mcp.js";

const server = String.raw`
const readline = require("node:readline");
const seen = [];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  seen.push(message.method);
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "cancellation", version: "1" } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: ["pending", "seen"].map(name => ({ name, inputSchema: { type: "object" } })) });
  } else if (message.method === "tools/call" && message.params.name === "seen") {
    send(message.id, { content: [], structuredContent: { seen } });
  }
});
`;

describe("node MCP cancellation over stdio", () => {
  it("preserves caller cancellation without reporting a tool timeout or retiring the session", async () => {
    const home = await createTempHomeEnv("openclaw-node-mcp-cancel-");
    const manager = await startNodeHostMcpManager({
      docs: { command: resolveTestNodeExecPath(), args: ["-e", server] },
    });
    try {
      const controller = new AbortController();
      const pending = manager.callMcpTool({
        server: "docs",
        tool: "pending",
        signal: controller.signal,
      });
      // This round trip proves that the pending call reached the real server before cancellation.
      await manager.callMcpTool({ server: "docs", tool: "seen" });
      controller.abort(new Error("caller cancelled the tool"));
      await expect(pending).rejects.toMatchObject({
        code: "MCP_TOOL_ERROR",
        message: "caller cancelled the tool",
      });
      const result = await manager.callMcpTool({ server: "docs", tool: "seen" });
      expect(result.structuredContent).toEqual({
        seen: expect.arrayContaining(["notifications/cancelled"]),
      });
    } finally {
      await manager.close();
      await home.restore();
    }
  });
});
