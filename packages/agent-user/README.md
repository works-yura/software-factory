# @factory/agent-user

Runs agent processes as a separate macOS user (`FACTORY_AGENT_USER`, e.g. `factory`) under a root-owned Seatbelt profile, so an agent cannot read the owner's files, the Factory server's code, database or logins. Design: [ADR-0041](../../docs/adr/0041-agents-run-as-a-separate-macos-user.md). System setup: `scripts/mac-mini/isolation/`.

- `agentUserFromEnv` — the configuration, off unless `FACTORY_AGENT_USER` is set.
- `agentLaunch` / `spawnAsAgent` — `sudo -n -C 4 -u <user> -- env -i … sh -c <loader> … sandbox-exec -f <profile> <command>`; the environment (tokens) goes through fd 3, never the command line.
- `agentProfile` — the Seatbelt profile (installed by `2-system.sh`, not written by the server).
- `signalAgentGroup` — stops a process group as the server and as the agent user.

Derived in part from [SandVault](https://github.com/webcoyote/sandvault) (Apache-2.0); see `THIRD_PARTY_NOTICES.md`.
