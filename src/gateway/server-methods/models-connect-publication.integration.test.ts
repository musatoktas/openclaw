import { beforeAll, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsSnapshotEvent } from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../../process/gateway-work-admission.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import * as chatMetadataHandler from "./chat-metadata-handler.js";
import { createModelsTestState } from "./models-integration.test-support.js";

// mock-isolation: Optional startup prewarming must not compete with the catalog request drain.
vi.mock("../server-startup-handler-prewarm.js", () => ({
  scheduleGatewayPrewarm: () => [{ stop() {} }],
}));

// Keep real catalog publication while excluding automatic startup work from the
// manual-RPC root-work assertion.
vi.mock("../server-runtime-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-runtime-services.js")>();
  return {
    ...actual,
    activateGatewayScheduledServices: (
      params: Parameters<typeof actual.activateGatewayScheduledServices>[0],
    ) => actual.activateGatewayScheduledServices({ ...params, minimalTestGateway: true }),
    scheduleGatewayPostReadyMaintenance: () => {},
  };
});

beforeAll(async () => {
  // Cold module compilation belongs to fixture preparation, before the real Gateway startup.
  await import("../server-start.js");
});

it("connect negotiates snapshots and preserves draft and saved-session catalog scopes", async () => {
  const publications: ModelsSnapshotEvent[] = [];
  const state = await createModelsTestState("models-connect-publication", {
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS },
  });
  const token = "synthetic-catalog-gateway-token";
  try {
    state.applyEnv();
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          "fixture:saved-account": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-saved-account-key",
          },
          "fixture:replacement-account": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-replacement-account-key",
          },
        },
      },
      "alpha",
    );
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const { port } = portClaim;
    const clientOptions = {
      token,
      clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      scopes: ["operator.admin"],
    } satisfies Omit<Parameters<typeof connectGatewayClient>[0], "url">;
    const connect = (
      options: Pick<
        Parameters<typeof connectGatewayClient>[0],
        "clientName" | "modelCatalog" | "caps" | "onEvent"
      >,
    ) => connectGatewayClient({ ...clientOptions, url: `ws://127.0.0.1:${port}`, ...options });
    const recordSnapshots =
      (
        target: ModelsSnapshotEvent[],
        published = () => {},
      ): NonNullable<Parameters<typeof connectGatewayClient>[0]["onEvent"]> =>
      (event) => {
        if (event.event === "models.snapshot") {
          target.push(event.payload as ModelsSnapshotEvent);
          published();
        }
      };
    const model = (id: string, manualSelectionAllowed?: boolean) => ({
      id,
      provider: "fixture",
      available: true,
      ...(manualSelectionAllowed === undefined ? {} : { manualSelectionAllowed }),
    });
    const { client, server } = await startGatewayWithClient({
      ...clientOptions,
      portClaim,
      configPath: state.configPath,
      modelCatalog: {},
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token },
          controlUi: { root: state.workspaceDir, allowedOrigins: [`http://127.0.0.1:${port}`] },
        },
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: {
            alpha: {
              workspace: state.workspaceDir,
              model: "fixture/first",
              modelPolicy: { allow: ["fixture/first"] },
            },
            bravo: {
              workspace: state.statePath("bravo"),
              model: "fixture/second",
              modelPolicy: { allow: ["fixture/second"] },
            },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              apiKey: "synthetic-key",
              models: [
                { id: "first", name: "First model" },
                { id: "second", name: "Second model" },
              ],
            },
          },
        },
      },
      onEvent: recordSnapshots(publications),
    });
    try {
      await expect
        .poll(() => publications, { timeout: 15_000 })
        .toMatchObject([
          {
            scope: { agentId: "alpha" },
            catalog: { models: [model("first")] },
          },
        ]);
      for (const selection of [
        { hint: "bravo", agentId: "bravo", modelId: "second" },
        { hint: "missing", agentId: "alpha", modelId: "first" },
      ]) {
        const otherPublications: ModelsSnapshotEvent[] = [];
        const other = await connect({
          modelCatalog: { agentId: selection.hint },
          onEvent: recordSnapshots(otherPublications),
        });
        try {
          await expect
            .poll(() => otherPublications)
            .toMatchObject([
              {
                scope: { agentId: selection.agentId },
                catalog: {
                  models: [model(selection.modelId)],
                },
              },
            ]);
          expect(publications).toHaveLength(1);
        } finally {
          await disconnectGatewayClient(other);
        }
      }
      const sessionKey = "agent:alpha:dashboard:12345678-1234-4123-8123-123456789abc";
      await upsertSessionEntryCore(
        { agentId: "alpha", sessionKey },
        {
          sessionId: "saved-model-catalog-session",
          updatedAt: Date.now(),
          providerOverride: "fixture",
          modelOverride: "second",
          modelOverrideRouteResolution: "resolved",
          authProfileOverride: "fixture:saved-account",
          authProfileOverrideSource: "user",
        },
      );
      for (const modelCatalog of [
        { agentId: "alpha", sessionKey },
        { agentId: "alpha", shortId: "12345678", slugHint: "saved" },
      ]) {
        const savedPublications: ModelsSnapshotEvent[] = [];
        const savedPublication = createDeferred();
        const saved = await connect({
          modelCatalog,
          caps: ["model-selection-policy"],
          onEvent: recordSnapshots(savedPublications, savedPublication.resolve),
        });
        try {
          // hello-ok precedes worker-backed catalog publication; join that event
          // instead of assuming preparation fits the polling matcher's deadline.
          await savedPublication.promise;
          expect(savedPublications[0]?.catalog.models).toHaveLength(2);
          expect(savedPublications).toMatchObject([
            {
              scope: { agentId: "alpha", sessionKey },
              catalog: {
                models: expect.arrayContaining([
                  expect.objectContaining(model("first", true)),
                  expect.objectContaining(model("second", false)),
                ]),
                accountSelection: {
                  kind: "shared",
                  authProfileId: "fixture:saved-account",
                  source: "user",
                },
              },
            },
          ]);
          expect(publications).toHaveLength(1);
          expect(loadSessionEntry({ agentId: "alpha", sessionKey })?.modelOverride).toBe("second");
        } finally {
          await disconnectGatewayClient(saved);
        }
      }
      await client.request("sessions.patch", {
        key: sessionKey,
        agentId: "alpha",
        label: "Initial catalog publication race",
      });
      const publicationStarted = createDeferred();
      const releasePublication = createDeferred();
      const resolveReadParams = chatMetadataHandler.resolveChatMetadataReadParams;
      const holdNextPublication = (
        started: ReturnType<typeof createDeferred<void>>,
        release: ReturnType<typeof createDeferred<void>>,
        settled = () => {},
      ) =>
        vi
          .spyOn(chatMetadataHandler, "resolveChatMetadataReadParams")
          .mockImplementationOnce(async (...args) => {
            const scope = await resolveReadParams(...args);
            if (!scope?.withCurrent) {
              throw new Error("Expected saved-session publication authority");
            }
            const withCurrent = scope.withCurrent;
            return {
              ...scope,
              withCurrent: async <T>(consume: () => T): Promise<Awaited<T>> => {
                started.resolve();
                await release.promise;
                try {
                  return await withCurrent(consume);
                } finally {
                  settled();
                }
              },
            };
          });
      let publicationSettled = false;
      // Cached projections still cross the live publication authority boundary.
      const publicationSpy = holdNextPublication(publicationStarted, releasePublication, () => {
        publicationSettled = true;
      });
      const racingPublications: ModelsSnapshotEvent[] = [];
      const sessionChanges: unknown[] = [];
      let racingClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        racingClient = await connect({
          modelCatalog: { agentId: "alpha", sessionKey },
          caps: ["model-selection-policy"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              racingPublications.push(event.payload as ModelsSnapshotEvent);
            } else if (event.event === "sessions.changed") {
              sessionChanges.push(event.payload);
            }
          },
        });
        await withTestTimeout(
          publicationStarted.promise,
          10_000,
          "Initial catalog publication did not start",
        );
        await racingClient.request("sessions.subscribe", { agentId: "alpha" });
        await racingClient.request("sessions.patch", {
          key: sessionKey,
          agentId: "alpha",
          model: "fixture/first@fixture:replacement-account",
        });
        await expect
          .poll(() => sessionChanges)
          .toContainEqual(expect.objectContaining({ sessionKey, reason: "patch" }));
        await expect(
          racingClient.request("models.list", { agentId: "alpha", sessionKey }),
        ).resolves.toMatchObject({
          accountSelection: { authProfileId: "fixture:replacement-account" },
        });
        expect(racingPublications).toEqual([]);
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        releasePublication.resolve();
        try {
          await expect.poll(() => getActiveGatewayRootWorkCount()).toBe(0);
        } catch (error) {
          try {
            console.error("Model catalog root work did not settle", {
              publicationSettled,
              holders: getActiveGatewayRootWorkHolders(),
            });
          } catch {
            // Diagnostic failures must not replace the original assertion.
          }
          throw error;
        }
        // A response on this same socket is a delivery barrier after initial work settles.
        await expect(
          racingClient.request("models.list", { agentId: "alpha", sessionKey }),
        ).resolves.toMatchObject({
          models: [model("first", true)],
          accountSelection: {
            authProfileId: "fixture:replacement-account",
            source: "user",
          },
        });
        for (const publication of racingPublications) {
          expect(publication.catalog.accountSelection).toMatchObject({
            authProfileId: "fixture:replacement-account",
          });
        }
      } finally {
        releasePublication.resolve();
        publicationSpy.mockRestore();
        if (racingClient) {
          await disconnectGatewayClient(racingClient);
        }
      }
      const unrelatedKey = "agent:alpha:catalog-other";
      await upsertSessionEntryCore(
        { agentId: "alpha", sessionKey: unrelatedKey },
        { sessionId: "unrelated-catalog-session", updatedAt: Date.now() },
      );
      const requestEntered = createDeferred();
      const releaseRequest = createDeferred();
      const pendingPublication = holdNextPublication(requestEntered, releaseRequest);
      const pendingCatalog = client.request("models.list", { agentId: "alpha", sessionKey });
      const deliveredCatalog = expect(pendingCatalog).resolves.toMatchObject({
        models: [model("first")],
        accountSelection: { authProfileId: "fixture:replacement-account" },
      });
      try {
        await awaitGateBeforeSettlement(
          requestEntered.promise,
          pendingCatalog,
          "Catalog request settled before its authority check",
        );
        await client.request("sessions.patch", {
          key: unrelatedKey,
          agentId: "alpha",
          label: "Renamed unrelated session",
        });
        releaseRequest.resolve();
        await deliveredCatalog;
      } finally {
        releaseRequest.resolve();
        pendingPublication.mockRestore();
        await Promise.allSettled([pendingCatalog, deliveredCatalog]);
      }
      for (const clientName of [
        GATEWAY_CLIENT_IDS.CONTROL_UI,
        GATEWAY_CLIENT_IDS.CLI,
        GATEWAY_CLIENT_IDS.IOS_APP,
        GATEWAY_CLIENT_IDS.ANDROID_APP,
      ]) {
        const oldPublications: unknown[] = [];
        const old = await connect({
          clientName,
          onEvent(event) {
            if (event.event === "models.snapshot") {
              oldPublications.push(event.payload);
            }
          },
        });
        try {
          await expect(old.request("models.list", { agentId: "alpha" })).resolves.toMatchObject({
            models: [{ id: "first", provider: "fixture" }],
          });
          expect(oldPublications).toEqual([]);
        } finally {
          await disconnectGatewayClient(old);
        }
      }
    } finally {
      await disconnectGatewayClient(client);
      await server.close({ reason: "catalog publication test complete" });
    }
  } finally {
    await state.cleanup();
  }
}, 60_000);
