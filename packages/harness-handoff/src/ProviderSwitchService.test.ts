// Ported from t3code apps/server/src/orchestration-v2/ProviderSwitchService.test.ts.
// Changed: @effect/vitest → vitest; the mocked registry Layer → a registry object; the Codex
// adapter's capability record → its `sessions` section; `DateTime` → ISO strings.
import { assert, it } from "vitest";

import type { OrchestrationV2ProviderCapabilities } from "./contracts.ts";
import { ProviderSwitchPlanError } from "./errors.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import { acpSelectionTransition } from "./selectionTransition.ts";

const driver = "codex";
const currentInstanceId = "codex_primary";
const currentSessionId = "session_primary";
const now = "2026-06-20T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(now) + seconds * 1_000).toISOString();
/** `CodexProviderCapabilitiesV2.sessions` in t3code. */
const CodexProviderCapabilitiesV2: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
};
const capabilitiesWithoutModelSwitch = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: false,
  },
};

type Projection = Parameters<ProviderSwitch.ProviderSwitchServiceV2Shape["plan"]>[0]["projection"];

function projection(): Projection {
  return {
    thread: {
      id: "thread_switch_service",
      modelSelection: { instanceId: currentInstanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/repo",
    },
    providerSessions: [
      {
        id: currentSessionId,
        providerInstanceId: currentInstanceId,
        status: "ready",
        cwd: "/repo",
        capabilities: capabilitiesWithoutModelSwitch,
        updatedAt: now,
      },
    ],
    providerThreads: [],
  } as unknown as Projection;
}

function deadSessionRecord(id: string, status: "stopped" | "error", updatedAt: string = later(1)) {
  return {
    ...projection().providerSessions[0]!,
    id,
    status,
    updatedAt,
  };
}

function serviceTest(
  metadata: Readonly<Record<string, { continuationKey: string }>>,
  planSelectionTransition: ProviderSwitch.ProviderSwitchAdapter["planSelectionTransition"] = async () => ({
    type: "restart_session",
  }),
) {
  const adapter = (): ProviderSwitch.ProviderSwitchAdapter => ({
    driver,
    getCapabilities: async () => capabilitiesWithoutModelSwitch,
    planSelectionTransition,
  });
  return ProviderSwitch.makeProviderSwitchService({
    get: async (instanceId) => {
      if (metadata[instanceId] === undefined) throw new Error(`Unknown instance ${instanceId}`);
      return adapter();
    },
    getMetadata: async (instanceId) => {
      const value = metadata[instanceId];
      if (value === undefined) throw new Error(`Unknown instance ${instanceId}`);
      return {
        driver,
        continuationKey: value.continuationKey,
        enabled: true,
        capabilities: capabilitiesWithoutModelSwitch,
      };
    },
  });
}

it("releases the newest live session, not the newest record overall", async () => {
  const service = serviceTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } });
  const thread = projection();
  const newerLiveSessionId = "session_newer_live";
  const result = await service.plan({
    projection: {
      ...thread,
      providerSessions: [
        ...thread.providerSessions,
        {
          ...thread.providerSessions[0]!,
          id: newerLiveSessionId,
          updatedAt: later(1),
        },
        deadSessionRecord("dead_session", "stopped", later(2)),
      ],
    },
    targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
  });
  assert.equal(result.transition.type, "restart_and_resume");
  assert.deepEqual(result.releaseProviderSessionIds, [newerLiveSessionId]);
});

it("creates a fresh session with handoff when every recorded session is dead", async () => {
  const service = serviceTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } });
  const thread = projection();
  const result = await service.plan({
    projection: {
      ...thread,
      providerSessions: [
        deadSessionRecord("dead_session_older", "stopped"),
        deadSessionRecord("dead_session_newer", "error", later(2)),
      ],
    },
    targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
  });
  assert.equal(result.transition.type, "create_with_handoff");
  assert.deepEqual(result.releaseProviderSessionIds, []);
});

function deadNativeThreadProjection(
  status: "stopped" | "error",
  capabilities = capabilitiesWithoutModelSwitch,
): Projection {
  const thread = projection();
  return {
    ...thread,
    thread: {
      ...thread.thread,
      activeProviderThreadId: "provider-thread:native",
    },
    providerSessions: [{ ...deadSessionRecord("dead_session", status), capabilities }],
    providerThreads: [
      {
        id: "provider-thread:native",
        driver,
        providerInstanceId: currentInstanceId,
        providerSessionId: "dead_session",
        appThreadId: thread.thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:abc",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  } as Projection;
}

it("falls back to the native provider thread when every recorded session is dead", async () => {
  const service = serviceTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } });
  const result = await service.plan({
    projection: deadNativeThreadProjection("stopped"),
    targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
  });
  assert.equal(result.transition.type, "restart_and_resume");
  assert.deepEqual(result.releaseProviderSessionIds, []);
});

it("hands off from a native provider thread after its session detaches", async () => {
  const service = serviceTest({
    [currentInstanceId]: { continuationKey: "codex:account:primary" },
    codex_other: { continuationKey: "codex:account:other" },
  });
  const result = await service.plan({
    projection: { ...deadNativeThreadProjection("stopped"), providerSessions: [] },
    targetModelSelection: {
      instanceId: "codex_other",
      model: "gpt-5.2-codex",
    },
  });
  assert.equal(result.transition.type, "create_with_handoff");
  assert.deepEqual(result.releaseProviderSessionIds, []);
});

it.each(["stopped", "error"] as const)(
  "applies a model change on next turn when a %s session negotiated model switching",
  async (deadStatus) => {
    const service = serviceTest(
      { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
      async (input) => acpSelectionTransition(input),
    );
    const result = await service.plan({
      projection: deadNativeThreadProjection(deadStatus, CodexProviderCapabilitiesV2),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "switch_model_in_session");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  },
);

it("rejects a model change the dead record never negotiated support for", async () => {
  const service = serviceTest(
    { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
    async (input) => acpSelectionTransition(input),
  );
  const result = await service
    .plan({
      projection: deadNativeThreadProjection("stopped"),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.instanceOf(result, ProviderSwitchPlanError);
});

it("distinguishes compatible and incompatible instances of the same driver", async () => {
  const service = serviceTest({
    [currentInstanceId]: { continuationKey: "codex:account:primary" },
    codex_compatible: { continuationKey: "codex:account:primary" },
    codex_incompatible: { continuationKey: "codex:account:other" },
  });
  const compatibleId = "codex_compatible";
  const incompatibleId = "codex_incompatible";
  const compatible = await service.plan({
    projection: projection(),
    targetModelSelection: { instanceId: compatibleId, model: "gpt-5.1-codex" },
  });
  const incompatible = await service.plan({
    projection: projection(),
    targetModelSelection: { instanceId: incompatibleId, model: "gpt-5.1-codex" },
  });
  assert.equal(compatible.transition.type, "restart_and_resume");
  assert.equal(incompatible.transition.type, "create_with_handoff");
});

/** Not in t3code: a target the registry does not know rejects instead of planning a handoff. */
it("rejects an unavailable target instance", async () => {
  const service = serviceTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } });
  const error = await service
    .plan({
      projection: projection(),
      targetModelSelection: { instanceId: "missing", model: "gpt-5.1-codex" },
    })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  assert.instanceOf(error, ProviderSwitchPlanError);
  assert.equal((error as ProviderSwitchPlanError)._tag, "ProviderSwitchPlanError");
  assert.equal(
    (error as ProviderSwitchPlanError).cause,
    "The target provider instance is unavailable.",
  );
});
