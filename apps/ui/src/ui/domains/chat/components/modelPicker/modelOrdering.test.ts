// Pins the semantics of the combined comparators: a stable sort where the first order that tells
// two items apart wins.
import { describe, expect, it } from "vitest";

import {
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

describe("sortModelsForProviderInstance", () => {
  const models = ["a", "b", "c", "d"].map((slug) => ({ slug }));

  it("keeps the catalog order without preferences", () => {
    expect(sortModelsForProviderInstance(models).map((model) => model.slug)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("puts ordered models first, then favorites first when grouped", () => {
    expect(
      sortModelsForProviderInstance(models, { modelOrder: ["c", "a"] }).map((m) => m.slug),
    ).toEqual(["c", "a", "b", "d"]);
    expect(
      sortModelsForProviderInstance(models, {
        modelOrder: ["c"],
        favoriteModels: ["d"],
        groupFavorites: true,
      }).map((m) => m.slug),
    ).toEqual(["d", "c", "a", "b"]);
  });
});

describe("sortProviderModelItems", () => {
  const items = [
    { instanceId: "mastra", slug: "openai/gpt" },
    { instanceId: "claude-code", slug: "claude-opus-5-5" },
    { instanceId: "mastra", slug: "anthropic/claude" },
  ];

  it("groups favorites, then follows the instance order, then the original order", () => {
    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: new Set([providerModelKey("mastra", "anthropic/claude")]),
        groupFavorites: true,
        instanceOrder: ["claude-code", "mastra"],
      }).map((item) => item.slug),
    ).toEqual(["anthropic/claude", "claude-opus-5-5", "openai/gpt"]);
  });

  it("does not mutate its input", () => {
    const copy = [...items];
    sortProviderModelItems(items, { instanceOrder: ["claude-code"] });
    expect(items).toEqual(copy);
  });
});
