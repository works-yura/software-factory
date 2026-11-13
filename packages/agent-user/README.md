# @factory/agent-user

Runs agent processes as a separate macOS user (`FACTORY_AGENT_USER`, e.g. `factory`) under a root-owned Seatbelt profile, so an agent cannot read the owner's files, the Factory server's code, database or logins. Design: [ADR-0041](../../docs/adr/0041-agents-run-as-a-separate-macos-user.md). System setup: `scripts/mac-mini/isolation/`. Derived in part from [SandVault](https://github.com/webcoyote/sandvault) (Apache-2.0); see `THIRD_PARTY_NOTICES.md`.

## Shape

| Module | Role | Pattern |
| --- | --- | --- |
| `config/` | `agentUserFromEnv`: off unless `FACTORY_AGENT_USER` is set; refuses root, the server's user, bad names, no work folder | — |
| `env/` | `agentEnvironment` (the agent's identity replaces the server's); `EnvTransport` / `PipeEnvTransport` (the environment on fd 3, a loader that refuses to run without the whole payload) | Strategy |
| `launch/` | `ProcessLauncher` (`SameUserLauncher`, `WrappingLauncher`); `CommandWrapper` layers `SudoWrapper` → `ClearEnvWrapper` → `EnvLoaderWrapper` → `SeatbeltWrapper`; `createAgentUserLauncher` | Strategy, Decorator |
| `seatbelt/` | SBPL as data (`sbpl.ts`), `SbplProfileBuilder`, one file per rule set (`rules/`), `SeatbeltAgentPolicy` (`SandboxPolicy`) | Builder, Composite |
| `signal/` | `ProcessSignaller`: `ServerSignaller`, `AgentUserSignaller` (sudo `kill`), `CompositeSignaller` | Composite |
| `spawn/` | `ProcessSpawner` / `LaunchingSpawner` (plan → spawn, inputs to their descriptors, `kill` to the signaller); `createProcessSpawner` | Factory Method |
| `system/` | absolute paths of the system binaries; `CommandRunner` | Port |

The chain an agent process runs in:

```
sudo -n -C 4 -u factory -- env -i HOME=… USER=… PATH=… sh -c <loader> factory-agent \
  sandbox-exec -f /var/factory/agent-factory.sb <command> <args…>        # environment on fd 3
```

## Tests

`corepack pnpm test` (unit, the loader under a real `sh`, 200 random strings through the quoting, the profile under the real `sandbox-exec`: SandVault's escape checks adapted to card folders on a data disk). `corepack pnpm coverage`.

`src/integration/as-agent-user.test.ts` runs the whole chain as the real agent user; it needs the system set up and `FACTORY_AGENT_USER_TEST=factory` (`FACTORY_AGENT_USER_TEST_STRICT=1` fails instead of skipping).
