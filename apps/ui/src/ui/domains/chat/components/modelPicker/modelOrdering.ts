// Model ordering as plain comparators: a stable sort over the combined orders, the first that
// tells two items apart wins.
import type { ProviderInstanceId } from "@factory/harness/models/contracts";

type Order<T> = (left: T, right: T) => number;

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(values.map((value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order<T> {
  return (left, right) =>
    Math.sign(
      (rank(left) ?? Number.POSITIVE_INFINITY) - (rank(right) ?? Number.POSITIVE_INFINITY) || 0,
    );
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order<T> {
  return (left, right) => Number(predicate(right)) - Number(predicate(left));
}

function combineAll<T>(orders: ReadonlyArray<Order<T>>): Order<T> {
  return (left, right) => {
    for (const order of orders) {
      const result = order(left, right);
      if (result !== 0) return result;
    }
    return 0;
  };
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(models.map((model) => model.slug));
  const orders: Array<Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return [...models].sort(combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const instanceOrder = new Map(
    (options?.instanceOrder ?? []).map((instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    items.map((item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return [...items].sort(combineAll(orders));
}
