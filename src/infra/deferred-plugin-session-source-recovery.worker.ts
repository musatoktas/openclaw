import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { DeferredSessionTranscriptReadOperations } from "./deferred-plugin-session-source-recovery.worker-contract.js";
import { databaseIdentity } from "./deferred-plugin-session-verification.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";
import type { DeferredPluginSessionImport } from "./state-migrations.deferred-session-import.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type RebuiltSessionSources = {
  receipt: LegacyMigrationReceipt;
  rebuilt: DeferredPluginSessionImport;
  storePath: string;
  sqlitePath: string;
  physicalIdentity: string;
};

export const deferredSessionImportOperations = {
  "deferredSessionImport.rebuildSources": (
    input: RebuiltSessionSources,
    { writeAdmitted }: WorkerWriteOperationContext,
  ) =>
    writeAdmitted(
      ({ db }) => {
        if (
          !isDeepStrictEqual(
            readLegacyMigrationReceiptFromDatabase(db, input.receipt.sourceKey),
            input.receipt,
          ) ||
          databaseIdentity(input.sqlitePath, "physical") !== input.physicalIdentity ||
          databaseIdentity(input.sqlitePath) !== input.rebuilt.databaseIdentity
        ) {
          throw new Error(
            "Deferred session import changed before its source index was rebuilt. Run openclaw doctor --fix against the same state/config to retry; sources remain protected.",
          );
        }
        const reportJson = JSON.stringify(input.rebuilt);
        const index = input.rebuilt.sources.find(
          (source) => source.path === path.resolve(input.storePath),
        );
        const query = getNodeSqliteKysely<DB>(db);
        executeSqliteQuerySync(
          db,
          query
            .updateTable("migration_sources")
            .set({
              report_json: reportJson,
              ...(index
                ? { source_sha256: index.identity.sha256, source_size_bytes: index.identity.size }
                : {}),
            })
            .where("source_key", "=", input.receipt.sourceKey),
        );
        executeSqliteQuerySync(
          db,
          query
            .updateTable("migration_runs")
            .set({ report_json: reportJson })
            .where("id", "=", input.receipt.sourceKey),
        );
      },
      { operationLabel: "state.rebuild-plugin-session-source-index" },
    ),
};

export const deferredSessionTranscriptReadOperations = {
  "deferredSessionImport.verifyMissingTranscript": (
    input: DeferredSessionTranscriptReadOperations["deferredSessionImport.verifyMissingTranscript"]["input"],
    context: SqliteReadOnlyOperationContext,
  ): boolean => {
    const result = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => {
        const query = getSessionKysely(db);
        const hash = createHash("sha256");
        let bytes = 0;
        for (const row of iterateSqliteQuerySync(
          db,
          query
            .selectFrom("transcript_events")
            .select(transcriptEventJsonSql(db).as("event_json"))
            .where("session_id", "=", input.sessionId)
            .orderBy("seq", "asc"),
        )) {
          const line = `${row.event_json}\n`;
          bytes += Buffer.byteLength(line);
          if (bytes > input.identity.size) {
            return false;
          }
          hash.update(line);
          if (bytes === input.identity.size) {
            return hash.digest("hex") === input.identity.sha256;
          }
        }
        return false;
      },
      { agentId: input.agentId, path: context.path, env: context.env },
    );
    return result.found && result.value;
  },
};
