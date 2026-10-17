import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersistedPluginModelCatalogs } from "../../agents/plugin-model-catalog-execution.js";
import {
  encodePluginModelCatalogRelativePath,
  replacePersistedPluginModelCatalogs,
} from "../../agents/plugin-model-catalog.js";
import { CronService } from "../../cron/service.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s post-ready storage consumers",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("reads refreshed provider catalogs through the selected agent owner", async () => {
      const database = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      const agentDir = path.dirname(database.path);
      const write = (contents: string) =>
        replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: {
            [encodePluginModelCatalogRelativePath("fixture")]: contents,
            [encodePluginModelCatalogRelativePath("other")]: '{"marker":"other"}',
          },
        });
      const first = '{"marker":"first catalog"}';
      const refreshed = '{"marker":"refreshed catalog"}';
      await write(first);
      expect(await loadPersistedPluginModelCatalogs(agentDir, ["fixture", "missing"])).toEqual([
        { pluginId: "fixture", contents: first },
      ]);
      await write(refreshed);
      expect(await loadPersistedPluginModelCatalogs(agentDir, ["fixture"])).toEqual([
        { pluginId: "fixture", contents: refreshed },
      ]);
    });

    it("starts cron and retains a disabled job across scheduler restart", async () => {
      const unexpectedDispatch = () => {
        throw new Error("Disabled cron conformance job must not dispatch");
      };
      const createCron = () =>
        new CronService({
          scheduler: createTestGatewayScheduler(),
          storePath: path.join(fixture.root, "cron", "post-ready.json"),
          cronEnabled: false,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          enqueueSystemEvent: unexpectedDispatch,
          requestHeartbeat: unexpectedDispatch,
          runIsolatedAgentJob: unexpectedDispatch,
        });
      const original = createCron();
      const restarted = createCron();
      try {
        await original.start();
        const job = await original.add({
          name: "post-ready durable job",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "synthetic cron marker" },
        });
        original.stop();
        await original.waitForIdle();
        await restarted.start();
        expect(await restarted.list({ includeDisabled: true })).toMatchObject([
          {
            id: job.id,
            name: "post-ready durable job",
            enabled: false,
            payload: { kind: "systemEvent", text: "synthetic cron marker" },
          },
        ]);
      } finally {
        original.stop();
        restarted.stop();
        await Promise.all([original.waitForIdle(), restarted.waitForIdle()]);
      }
    });
  },
);
