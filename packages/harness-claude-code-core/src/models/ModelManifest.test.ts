// Ported from t3code apps/server/src/provider/ModelManifest.test.ts: the `resolveProviderCatalog`
// cases and the invalid manifests. The `ModelManifest service` cases (remote fetch, disk cache,
// TTLs) test the refresh, which is not ported; their invalid payloads check `decodeManifest` here.
import { assert, describe, it } from "vitest";

import * as ModelManifest from "./ModelManifest.ts";

describe("resolveProviderCatalog", () => {
  it.each([
    { releasedAt: "2026-01-01", now: "2026-01-01T00:00:00Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-07T23:59:59.999Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-08T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-01", now: "2026-02-01T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-02T00:00:00Z", now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: undefined, now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: "invalid", now: "2026-01-01T00:00:00Z", badge: undefined },
  ])("derives the new badge from releasedAt=$releasedAt at $now", ({ releasedAt, now, badge }) => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              ...(releasedAt === undefined ? {} : { releasedAt }),
            },
            {
              slug: "model-legacy",
              name: "Model Legacy",
              status: "legacy",
              releasedAt: now,
            },
          ],
        },
      },
    };
    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      "synthetic",
      Date.parse(now),
    );
    assert.strictEqual(catalog?.models[0]?.badge, badge);
    assert.strictEqual(catalog?.models[1]?.badge, undefined);
  });

  it("expires badges when rereading a cached manifest without a refresh", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              releasedAt: "1970-01-01T00:00:00Z",
            },
          ],
        },
      },
    };
    // The badge is derived on each read from the clock, so a held manifest still expires it.
    const read = (nowMs: number) =>
      ModelManifest.resolveProviderCatalog(manifest, "synthetic", nowMs)?.models[0]?.badge;
    assert.strictEqual(read(0), "new");
    assert.strictEqual(read(7 * 24 * 60 * 60 * 1000), undefined);
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, "synthetic"),
      );
    }
  });
});

const REMOTE_UPDATED_AT = "2099-01-01T00:00:00Z";

const REMOTE_MANIFEST: ModelManifest.ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {
    codex: ["remote-model"],
    claudeAgent: ["remote-agent-model"],
  },
};

const REMOTE_CLAUDE_MANIFEST: ModelManifest.ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          adapter: { claudeCode: { effortMap: { extreme: "high" } } },
        },
      },
      models: [
        {
          slug: "remote-only-model",
          name: "Remote Only Model",
          status: "current",
          profile: "synthetic",
        },
      ],
    },
  },
};

const remoteClaudeManifestWithCompatibility = (
  compatibility: unknown,
): ModelManifest.ModelManifestData => ({
  ...REMOTE_CLAUDE_MANIFEST,
  providers: {
    claudeAgent: {
      profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
      models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models.map((model) => ({
        ...model,
        adapter: { claudeCode: compatibility },
      })),
    },
  },
});

const INVALID_REMOTE_MANIFESTS: ReadonlyArray<ModelManifest.ModelManifestData> = [
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {
          synthetic: {
            adapter: { claudeCode: { effortMap: { extreme: 123 } } },
          },
        },
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {},
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: [
          ...REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
          {
            slug: "remote-only-model",
            name: "Duplicate Remote Model",
            status: "current",
            profile: "synthetic",
          },
        ],
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        defaults: { chat: "absent-model" },
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  remoteClaudeManifestWithCompatibility({ minVersion: "2.x" }),
  remoteClaudeManifestWithCompatibility({ maxVersionExclusive: "2.x" }),
  remoteClaudeManifestWithCompatibility({
    minVersion: "2.2",
    maxVersionExclusive: "2.1",
  }),
];

describe("decodeManifest", () => {
  it("accepts valid manifests and the bundled one", () => {
    assert.isNotNull(ModelManifest.decodeManifest(REMOTE_MANIFEST));
    assert.isNotNull(ModelManifest.decodeManifest(REMOTE_CLAUDE_MANIFEST));
    assert.isNotNull(ModelManifest.decodeManifest(ModelManifest.BUNDLED_MODEL_MANIFEST));
  });

  it.each(INVALID_REMOTE_MANIFESTS.map((manifest, index) => [index, manifest] as const))(
    "rejects invalid manifest %i",
    (_index, manifest) => {
      assert.isNull(ModelManifest.decodeManifest(manifest));
    },
  );
});
