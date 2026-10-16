import { execFile } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

export function createModelsTestState(
  label: string,
  options: Parameters<typeof createOpenClawTestState>[0] = {},
) {
  return createOpenClawTestState({
    ...options,
    label,
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      ...options.env,
    },
  });
}

export async function listenModelsEndpoint(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Models fixture did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

export async function closeModelsEndpoint(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// A separate writer supplies no in-process Gateway receipt; refresh must load the durable change.
export async function writeAuthStoreExternally(
  state: OpenClawTestState,
  databasePath: string,
  store: AuthProfileStore | null,
) {
  const result = await promisify(execFile)(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "--eval",
      `
              import { DatabaseSync } from "node:sqlite";
              const database = new DatabaseSync(process.argv[1]);
              try {
                const result = process.argv[2] === "null"
                  ? database.prepare("DELETE FROM auth_profile_store WHERE store_key = ?").run("primary")
                  : database.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?")
                    .run(process.argv[2], Date.now(), "primary");
                process.stdout.write(String(result.changes));
              } finally {
                database.close();
              }
            `,
      databasePath,
      JSON.stringify(store),
    ],
    { env: { ...state.env, NODE_OPTIONS: undefined } },
  );
  expect(result.stdout).toBe("1");
}
