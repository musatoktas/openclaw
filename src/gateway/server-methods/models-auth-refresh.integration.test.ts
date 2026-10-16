import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { SHARED_AUTH_STORE_STATE_KEY } from "../../agents/auth-profiles/sqlite-json.js";
import { writePersistedAuthProfileStoreRaw } from "../../agents/auth-profiles/sqlite.js";
import { getRuntimeConfig, resolveConfigPath, resolveStateDir } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { deleteSecretStoreEntry, writeSecretStoreEntry } from "../../secrets/store/secret-store.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import {
  createModelsTestState,
  writeAuthStoreExternally,
} from "./models-integration.test-support.js";

function expectIsolatedState(state: Awaited<ReturnType<typeof createModelsTestState>>) {
  expect([process.env.OPENCLAW_HOME, resolveStateDir(), resolveConfigPath()]).toEqual([
    state.home,
    state.stateDir,
    state.configPath,
  ]);
  for (const resolved of [state.home, resolveStateDir(), resolveConfigPath()]) {
    expect(isPathInside(state.root, resolved)).toBe(true);
  }
}

function expectProfile(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  provider: string,
  profileId: string,
) {
  return expect(client.request("models.authStatus", { agentId: "main" })).resolves.toMatchObject({
    providers: expect.arrayContaining([
      expect.objectContaining({
        provider,
        profiles: expect.arrayContaining([expect.objectContaining({ profileId })]),
      }),
    ]),
  });
}

describe("models.authRefresh", () => {
  it("publishes and clears quoted provider warnings through registered refresh", async () => {
    const state = await createModelsTestState("models-auth-refresh-quoted");
    const token = "quoted-auth-refresh-token";
    const providerNames = ["plain", "123", "local.service"];
    const providerPaths = [
      "models.providers.plain.apiKey",
      'models.providers["123"].apiKey',
      'models.providers["local.service"].apiKey',
    ];
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
      models: {
        providers: Object.fromEntries(
          providerNames.map((provider) => [
            provider,
            {
              baseUrl: "https://example.invalid/v1",
              apiKey: { source: "store", provider: "default", id: "REFRESH_PROVIDER_KEY" },
              models: [],
            },
          ]),
        ),
      },
      skills: {
        entries: {
          unavailable: {
            apiKey: { source: "store", provider: "default", id: "MISSING_SKILL_KEY" },
          },
        },
      },
    };
    const saveProviderKey = (value: string) =>
      writeSecretStoreEntry({
        scope: { kind: "team" },
        name: "REFRESH_PROVIDER_KEY",
        value,
        kind: "secret",
        updatedBy: "test",
        database: { env: state.env },
      });
    try {
      expectIsolatedState(state);
      await saveProviderKey("initial-provider-credential");
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const unrelatedWarnings = expectDefined(
          getActiveSecretsRuntimeSnapshot(),
          "Gateway published its secrets runtime",
        ).warnings.filter((warning) => warning.path === "skills.entries.unavailable.apiKey");
        expect(unrelatedWarnings).toHaveLength(1);
        await deleteSecretStoreEntry({
          scope: { kind: "team" },
          name: "REFRESH_PROVIDER_KEY",
          database: { env: state.env },
        });
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "update" }),
        ).resolves.toEqual({ refreshed: true });
        for (const providerPath of providerPaths) {
          expect(getActiveSecretsRuntimeSnapshot()?.warnings).toContainEqual(
            expect.objectContaining({ path: providerPath }),
          );
        }
        expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
          expect.arrayContaining(unrelatedWarnings),
        );

        await saveProviderKey("recovered-provider-credential");
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "update" }),
        ).resolves.toEqual({ refreshed: true });
        expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(unrelatedWarnings);
        for (const provider of providerNames) {
          expect(getRuntimeConfig().models?.providers?.[provider]?.apiKey).toBe(
            "recovered-provider-credential",
          );
        }
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  });

  it("publishes saved credentials and persisted removals before acknowledging an administrator", async () => {
    const state = await createModelsTestState("models-auth-refresh");
    const token = "auth-refresh-integration-token";
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    try {
      expectIsolatedState(state);
      const { client, server, port } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
          expect.objectContaining({ providers: expect.any(Array) }),
        );
        // Change durable ownership without updating the pinned shared-store location.
        writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
        runOpenClawStateWriteTransaction((database) => {
          writePersistedAuthProfileStoreRaw(
            {
              version: 1,
              profiles: {
                "auth-refresh-shared:proof": {
                  type: "token",
                  provider: "auth-refresh-shared",
                  token: "synthetic-shared-token",
                },
              },
            },
            undefined,
            database,
          );
        });
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "login" }),
        ).resolves.toEqual({ refreshed: true });
        await expectProfile(client, "auth-refresh-shared", "auth-refresh-shared:proof");
        const agentDatabasePath = await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "auth-refresh-proof:local": {
              type: "token",
              provider: "auth-refresh-proof",
              token: "saved-fixture-token",
            },
          },
        });
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "login" }),
        ).resolves.toEqual({ refreshed: true });
        await expectProfile(client, "auth-refresh-proof", "auth-refresh-proof:local");
        await writeAuthStoreExternally(state, agentDatabasePath, null);
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "logout" }),
        ).resolves.toEqual({ refreshed: true });
        const refreshed = await client.request<ModelAuthStatusResult>("models.authStatus", {
          agentId: "main",
        });
        const profileIds = refreshed.providers.flatMap(({ profiles }) =>
          profiles.map(({ profileId }) => profileId),
        );
        expect(profileIds).not.toContain("auth-refresh-proof:local");
        expect(profileIds).toContain("auth-refresh-shared:proof");
        const reader = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          scopes: ["operator.read"],
        });
        try {
          await expect(
            reader.request("models.authRefresh", { agentId: "main", operation: "update" }),
          ).rejects.toThrow("operator.admin");
          await expect(reader.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
            expect.objectContaining({ providers: expect.any(Array) }),
          );
        } finally {
          await disconnectGatewayClient(reader);
        }
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  });
});
