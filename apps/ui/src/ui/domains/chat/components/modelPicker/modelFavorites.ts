// The model picker's favorites, t3code's `useEnvironmentModelPreferences().favorites` and
// `useToggleEnvironmentModelFavorite` (hooks/useSettings.ts). t3code keeps them in its server
// settings; v4 has no per-person settings store on the server, so they live in this browser's
// localStorage next to v4's other UI preferences (`mastracode.*`), and follow the person across
// Factories and chats like t3code's.
import type { ProviderInstanceId } from "@factory/harness/models/contracts";
import {
  createLocalStorageStore,
  useLocalStorageStore,
} from "@mastra/playground-ui/hooks/use-local-storage-store";

export interface ModelFavorite {
  provider: ProviderInstanceId;
  model: string;
}

const MODEL_FAVORITES_KEY = "mastracode.modelPicker.favorites";
const NO_FAVORITES: ReadonlyArray<ModelFavorite> = [];

function parseFavorites(stored: unknown): ReadonlyArray<ModelFavorite> {
  if (!Array.isArray(stored)) return NO_FAVORITES;
  return stored.filter(
    (entry): entry is ModelFavorite =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelFavorite).provider === "string" &&
      typeof (entry as ModelFavorite).model === "string",
  );
}

const favoritesStore = createLocalStorageStore<ReadonlyArray<ModelFavorite>>({
  key: MODEL_FAVORITES_KEY,
  defaultValue: NO_FAVORITES,
  parse: parseFavorites,
});

export function useModelFavorites(): { favorites: ReadonlyArray<ModelFavorite> } {
  return { favorites: useLocalStorageStore(favoritesStore) };
}

export function toggleModelFavorite(instanceId: ProviderInstanceId, slug: string): void {
  const favorites = favoritesStore.read();
  const exists = favorites.some((fav) => fav.provider === instanceId && fav.model === slug);
  favoritesStore.write(
    exists
      ? favorites.filter((fav) => !(fav.provider === instanceId && fav.model === slug))
      : [...favorites, { provider: instanceId, model: slug }],
  );
}
