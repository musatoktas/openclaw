import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { runWithLocalStateOwner } from "../../plugin-sdk/cli-state-owner.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);

function readAnchor(pathname: string) {
  using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
  return {
    identity: anchor.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all(),
    tables: anchor
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all(),
  };
}

it.skipIf(!connection)(
  "admits PostgreSQL from selected state dotenv before a cold local command observes config",
  async () => {
    const root = directories.make("cli-owner-postgres-");
    const configPath = path.join(root, "openclaw.json");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const config = {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "OPENCLAW_CLI_OWNER_TEST_DSN" },
          schemaPrefix: `cli_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        },
      },
    } satisfies OpenClawConfig;
    const raw = `${JSON.stringify(config)}\n`;
    await fs.writeFile(configPath, raw);
    await fs.writeFile(
      path.join(root, ".env"),
      `OPENCLAW_CLI_OWNER_TEST_DSN=${JSON.stringify(connection)}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("HOME", root);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_CLI_OWNER_TEST_DSN", undefined);
    resetDatabaseEngineSelectionForTest();
    resetConfigRuntimeState();
    const client = new Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      // Seed a prior Gateway's store without installing a process-wide CLI boot choice.
      const selection = await resolveDatabaseEngineSelection(config, {
        ...process.env,
        OPENCLAW_CLI_OWNER_TEST_DSN: connection,
      });
      await withDatabaseEngineSelection(selection, async () => {
        namespace = withEngineStoreAdmission(
          () => getPostgresPhysicalFacts(openOpenClawStateDatabase().db)?.namespace,
        );
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      });
      assert(namespace);
      expect(getDatabaseEngineSelection()).toBeUndefined();
      expect(process.env.OPENCLAW_CLI_OWNER_TEST_DSN).toBeUndefined();
      const anchorBefore = readAnchor(databasePath);
      expect(anchorBefore.tables).not.toContainEqual({ name: "config_health_entries" });

      const operation = {
        method: "memory.cli",
        params: {},
        target: "memory stores",
        onForeignOwner: "refuse" as const,
        databaseEngine: "configured" as const,
        runLocal: async () =>
          await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })(),
      };
      const loaded = await runWithLocalStateOwner(operation);
      expect(loaded.database?.engine).toBe("postgres");
      expect(getDatabaseEngineSelection()).toBeUndefined();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);

      const health = await client.query<{ last_known_good_json: string }>(
        `SELECT last_known_good_json FROM "${namespace}".config_health_entries WHERE config_path = $1`,
        [configPath],
      );
      expect(health.rows).toHaveLength(1);
      assert(health.rows[0]);
      expect(JSON.parse(health.rows[0].last_known_good_json)).toMatchObject({
        hash: createHash("sha256").update(raw).digest("hex"),
        bytes: Buffer.byteLength(raw),
        gatewayMode: "local",
      });
      expect(readAnchor(databasePath)).toEqual(anchorBefore);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      try {
        if (namespace) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await client.end();
        resetDatabaseEngineSelectionForTest();
        resetConfigRuntimeState();
        vi.unstubAllEnvs();
      }
    }
  },
);
