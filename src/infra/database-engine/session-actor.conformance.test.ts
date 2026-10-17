import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import { createDurableSessionActorFactory } from "../../config/sessions/session-actor-durable.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

describe
  .skipIf(!mixedAgentConnection)
  .each(mixedAgentPairs.filter(({ stateEngine, agentEngine }) => stateEngine === agentEngine))(
  "$agentEngine durable session actor",
  ({ stateEngine, agentEngine }) => {
    const pair = useMixedAgentPair(stateEngine, agentEngine);

    it("commits transcript appends, retains warm state, rolls back refused writes, and reopens", async () => {
      const options = { agentId: "main", env: process.env };
      const sessionKey = "agent:main:actor-conformance";
      const sessionId = "actor-conformance";
      const acquire = async () => {
        const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
        const identity = readOpenClawAgentDatabaseIdentity(database);
        assert(typeof identity.identity === "string");
        const actor = await createDurableSessionActorFactory({
          ...options,
          path: database.path,
        }).acquire(
          {
            sessionKey,
            database: {
              kind: "file",
              physicalIdentity: identity.identity,
              birthtime: identity.birthtime,
              nativeLocation: database.path,
            },
          },
          { assertCurrent() {}, assertReadable() {} },
        );
        const scope = { ...options, storePath: database.path, sessionKey, sessionId };
        return {
          actor,
          append: (content: string, initialize = false) =>
            appendSessionManagerActor({
              actor,
              toolResult: false,
              assertCurrent() {},
              append: {
                kind: "message",
                input: {
                  scope,
                  cwd: "/synthetic",
                  messageJson: JSON.stringify({ role: "user", content, timestamp: 2 }),
                },
                ...(initialize
                  ? { initialization: { scope, entry: { sessionId, updatedAt: 2 } } }
                  : {}),
              },
            }),
        };
      };
      const first = await acquire();
      try {
        const appended = await first.append("first input", true);
        expect(appended.failure).toBeUndefined();
        expect(appended).toMatchObject({
          committed: { kind: "message", value: { snapshot: { ok: true } } },
        });
        const initial = first.actor.snapshot(authority);
        assert(initial);
        expect(initial.entry?.sessionId).toBe(sessionId);
        const patched = await first.actor.patch(
          { commandId: "warm", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 543 }] },
          authority,
        );
        expect(patched).toMatchObject({
          kind: "committed",
          receipt: { beforeVersion: initial.version },
        });
        const beforeRefusal = first.actor.snapshot(authority);
        assert(beforeRefusal);
        expect(beforeRefusal.entry?.updatedAt).toBe(543);
        expect(
          await first.actor.patch(
            {
              commandId: "refused",
              phaseId: "turn",
              reducers: [{ kind: "activity", updatedAt: 999 }],
            },
            {
              assertCurrent() {},
              authorize(stage) {
                if (stage === "commit") {
                  throw new Error("synthetic live authority revocation");
                }
              },
            },
          ),
        ).toMatchObject({
          kind: "rolled-back",
          error: { message: "synthetic live authority revocation" },
        });
        const afterRefusal = await first.actor.read(authority);
        expect(afterRefusal.entry?.updatedAt).toBe(543);
        // SQLite invalidates native write caches even after rollback; PG publishes only COMMIT.
        if (agentEngine === "postgres") {
          expect(afterRefusal).toMatchObject({
            version: beforeRefusal.version,
            writeToken: beforeRefusal.writeToken,
          });
        }
      } finally {
        await first.actor.release();
      }
      withEngineStoreAdmission(() => closeOpenClawAgentDatabases(pair.root));
      await cleanupSessionStateForTest({ stateDir: pair.root });

      const reopened = await acquire();
      try {
        expect((await reopened.actor.read(authority)).entry?.updatedAt).toBe(543);
        expect((await reopened.append("continued input")).failure).toBeUndefined();
        const rows = withEngineStoreAdmission(() =>
          readTranscriptEventRows(openOpenClawAgentDatabase(options), sessionId),
        );
        expect(rows.map((row) => JSON.parse(row.eventJson))).toMatchObject([
          { type: "session", id: sessionId },
          { type: "message", message: { role: "user", content: "first input" } },
          { type: "message", message: { role: "user", content: "continued input" } },
        ]);
      } finally {
        await reopened.actor.release();
      }
    });
  },
);
