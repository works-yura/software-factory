// The composer's model selection: a thread's draft pick per provider instance
// (`modelSelectionByProvider`, `activeProvider`, `modelSelectionExplicit`) and the sticky choices
// that follow the person into new chats (`stickyModelSelectionByProvider`,
// `stickyOptionsByModelByProvider`, `stickyActiveProvider`). It is a `createLocalStorageStore`
// (playground-ui), which keeps the state in this browser's localStorage; prompt text, terminal
// contexts, runtime mode and the other draft fields live in `ChatCommandsProvider`.
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@factory/harness/models/contracts";
import { createModelSelection } from "@factory/harness/models/model";
import {
  createLocalStorageStore,
  useLocalStorageStore,
} from "@mastra/playground-ui/hooks/use-local-storage-store";

/** A chat thread's key: its session id, which a draft keeps when its session is created. */
export type ComposerThreadTarget = string;

export interface ComposerThreadDraftState {
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
  /** The person picked on this thread: the pick waits to be applied to the session. */
  modelSelectionExplicit?: boolean;
}

export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyOptionsByModelByProvider: Partial<
    Record<ProviderInstanceId, Record<string, ReadonlyArray<ProviderOptionSelection>>>
  >;
  stickyActiveProvider: ProviderInstanceId | null;
}

const COMPOSER_DRAFT_STORAGE_KEY = "mastracode.composerModelDraft";

const EMPTY_STATE: ComposerDraftStoreState = {
  draftsByThreadKey: {},
  stickyModelSelectionByProvider: {},
  stickyOptionsByModelByProvider: {},
  stickyActiveProvider: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedState(stored: unknown): ComposerDraftStoreState {
  if (!isRecord(stored)) return EMPTY_STATE;
  return {
    draftsByThreadKey: isRecord(stored.draftsByThreadKey)
      ? (stored.draftsByThreadKey as ComposerDraftStoreState["draftsByThreadKey"])
      : {},
    stickyModelSelectionByProvider: isRecord(stored.stickyModelSelectionByProvider)
      ? (stored.stickyModelSelectionByProvider as ComposerDraftStoreState["stickyModelSelectionByProvider"])
      : {},
    stickyOptionsByModelByProvider: isRecord(stored.stickyOptionsByModelByProvider)
      ? (stored.stickyOptionsByModelByProvider as ComposerDraftStoreState["stickyOptionsByModelByProvider"])
      : {},
    stickyActiveProvider:
      typeof stored.stickyActiveProvider === "string" ? stored.stickyActiveProvider : null,
  };
}

const store = createLocalStorageStore<ComposerDraftStoreState>({
  key: COMPOSER_DRAFT_STORAGE_KEY,
  defaultValue: EMPTY_STATE,
  parse: parsePersistedState,
});

function equals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return { modelSelectionByProvider: {}, activeProvider: null };
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    !draft.modelSelectionExplicit
  );
}

function normalizeModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!modelSelection?.instanceId || !modelSelection.model.trim()) return null;
  return modelSelection;
}

type SetState = (
  update: (state: ComposerDraftStoreState) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>,
) => void;

const set: SetState = (update) => {
  const state = store.read();
  const next = update(state);
  if (next === state) return;
  store.write({ ...state, ...next });
};

function withDraft(
  state: ComposerDraftStoreState,
  threadKey: string,
  nextDraft: ComposerThreadDraftState,
): Record<string, ComposerThreadDraftState> {
  const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
  if (shouldRemoveDraft(nextDraft)) {
    delete nextDraftsByThreadKey[threadKey];
  } else {
    nextDraftsByThreadKey[threadKey] = nextDraft;
  }
  return nextDraftsByThreadKey;
}

export const composerDraftActions = {
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => {
    const normalized = normalizeModelSelection(modelSelection);
    set((state) => {
      if (!normalized) {
        return state;
      }
      const current = state.stickyModelSelectionByProvider[normalized.instanceId];
      // Model-only updates omit options; preserve sticky traits across model switches and new chats.
      const nextSelection =
        normalized.options !== undefined
          ? normalized
          : createModelSelection(normalized.instanceId, normalized.model, current?.options);
      const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
        ...state.stickyModelSelectionByProvider,
        [normalized.instanceId]: nextSelection,
      };
      if (equals(state.stickyModelSelectionByProvider, nextMap)) {
        return state.stickyActiveProvider === normalized.instanceId
          ? state
          : { stickyActiveProvider: normalized.instanceId };
      }
      return {
        stickyModelSelectionByProvider: nextMap,
        stickyActiveProvider: normalized.instanceId,
      };
    });
  },
  setModelSelection: (
    threadKey: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: { explicit?: boolean; replaceOptions?: boolean },
  ) => {
    if (threadKey.length === 0) {
      return;
    }
    const normalized = normalizeModelSelection(modelSelection);
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      if (!existing && normalized === null) {
        return state;
      }
      const base = existing ?? createEmptyThreadDraft();
      const nextMap = { ...base.modelSelectionByProvider };
      if (normalized) {
        const current = nextMap[normalized.instanceId];
        if (normalized.options !== undefined || opts?.replaceOptions) {
          nextMap[normalized.instanceId] = normalized;
        } else {
          nextMap[normalized.instanceId] = createModelSelection(
            normalized.instanceId,
            normalized.model,
            current?.options,
          );
        }
      }
      const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
      if (
        opts?.explicit !== true &&
        equals(base.modelSelectionByProvider, nextMap) &&
        base.activeProvider === nextActiveProvider &&
        !base.modelSelectionExplicit
      ) {
        return state;
      }
      const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
      const nextDraft: ComposerThreadDraftState = {
        ...restBase,
        modelSelectionByProvider: nextMap,
        activeProvider: nextActiveProvider,
        ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
      };
      return { draftsByThreadKey: withDraft(state, threadKey, nextDraft) };
    });
  },
  releaseModelSelection: (threadKey: ComposerThreadTarget, modelSelection: ModelSelection) => {
    set((state) => {
      const draft = state.draftsByThreadKey[threadKey];
      // A newer pick, even of the same model, is still waiting for its own reply.
      if (
        !draft?.activeProvider ||
        !equals(draft.modelSelectionByProvider[draft.activeProvider], modelSelection)
      ) {
        return state;
      }
      const { modelSelectionExplicit: _explicit, ...retained } = draft;
      const next = { ...retained, activeProvider: null, modelSelectionByProvider: {} };
      return { draftsByThreadKey: withDraft(state, threadKey, next) };
    });
  },
  setProviderModelOptions: (
    threadKey: ComposerThreadTarget,
    instanceKey: ProviderInstanceId,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options: { model: string; persistSticky?: boolean },
  ) => {
    if (threadKey.length === 0) {
      return;
    }
    const fallbackModel = options.model;
    const providerOpts =
      nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      const base = existing ?? createEmptyThreadDraft();

      const nextMap = { ...base.modelSelectionByProvider };
      nextMap[instanceKey] = createModelSelection(instanceKey, fallbackModel, providerOpts);

      let nextStickyMap = state.stickyModelSelectionByProvider;
      let nextOptionsByModel = state.stickyOptionsByModelByProvider;
      let nextStickyActiveProvider = state.stickyActiveProvider;
      if (options.persistSticky === true) {
        nextStickyMap = { ...state.stickyModelSelectionByProvider };
        const stickyBase =
          nextStickyMap[instanceKey] ??
          base.modelSelectionByProvider[instanceKey] ??
          createModelSelection(instanceKey, fallbackModel);
        const rememberedModel = options.model || stickyBase.model;
        if (providerOpts) {
          nextStickyMap[instanceKey] = createModelSelection(
            instanceKey,
            stickyBase.model,
            providerOpts,
          );
          nextOptionsByModel = {
            ...state.stickyOptionsByModelByProvider,
            [instanceKey]: {
              ...state.stickyOptionsByModelByProvider[instanceKey],
              [rememberedModel]: providerOpts,
            },
          };
        } else if ((stickyBase.options?.length ?? 0) > 0) {
          const { options: _, ...rest } = stickyBase;
          nextStickyMap[instanceKey] = rest as ModelSelection;
          const rememberedByModel = {
            ...state.stickyOptionsByModelByProvider[instanceKey],
          };
          delete rememberedByModel[rememberedModel];
          nextOptionsByModel = {
            ...state.stickyOptionsByModelByProvider,
            [instanceKey]: rememberedByModel,
          };
        }
        nextStickyActiveProvider = instanceKey;
      }

      const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
      const nextDraft: ComposerThreadDraftState = {
        ...restBase,
        activeProvider: instanceKey,
        modelSelectionByProvider: nextMap,
        modelSelectionExplicit: true,
      };

      return {
        draftsByThreadKey: withDraft(state, threadKey, nextDraft),
        ...(options.persistSticky === true
          ? {
              stickyModelSelectionByProvider: nextStickyMap,
              stickyOptionsByModelByProvider: nextOptionsByModel,
              stickyActiveProvider: nextStickyActiveProvider,
            }
          : {}),
      };
    });
  },
};

export const useComposerDraftStore = Object.assign(
  function useComposerDraftStore<T>(selector: (state: ComposerDraftStoreState) => T): T {
    return selector(useLocalStorageStore(store));
  },
  { getState: () => store.read() },
);

/** The thread's pending pick, when the person made one that has not reached the session yet. */
export function useComposerDraftModelState(
  threadKey: ComposerThreadTarget,
): ComposerThreadDraftState | undefined {
  return useComposerDraftStore((state) => state.draftsByThreadKey[threadKey]);
}
