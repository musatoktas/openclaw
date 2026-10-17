import { describe, expect, it } from "vitest";
import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s transcript report navigation",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("selects the latest custom report from persisted transcript navigation", async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:report-navigation",
        sessionId: "report-navigation",
      };
      const content = "synthetic report content ".repeat(400);
      const selected = { customType: "status", content, details: { selected: true } };
      withEngineStoreAdmission(() => {
        const resolved = resolveSqliteTranscriptScope(scope);
        runOpenClawAgentWriteTransaction((database) => {
          writeSessionEntry(database, scope.sessionKey, {
            sessionId: scope.sessionId,
            updatedAt: 1,
          });
          replaceSqliteTranscriptEventsInTransaction(database, resolved, [
            { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
            {
              type: "message",
              id: "root",
              parentId: null,
              message: { role: "user", content },
            },
            {
              type: "custom_message",
              id: "selected",
              parentId: "root",
              ...selected,
              display: true,
            },
          ]);
          const rows = executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("transcript_events")
              .select(["event_json", "event_zstd"])
              .where("session_id", "=", scope.sessionId),
          ).rows;
          // SQLite uses zstd navigation; PostgreSQL keeps canonical JSON and delegates to TOAST.
          expect(
            rows.filter((row) => row.event_json === null && row.event_zstd !== null),
          ).toHaveLength(engine === "sqlite" ? 2 : 0);
        }, toDatabaseOptions(resolved));
      });
      const observed: unknown[] = [];
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "custom",
          customTypes: ["status"],
          selectReport(latest) {
            observed.push(latest);
            return undefined;
          },
        }),
      ).resolves.toEqual({ ok: true, value: undefined });
      expect(observed).toEqual([selected]);
    });
  },
);
