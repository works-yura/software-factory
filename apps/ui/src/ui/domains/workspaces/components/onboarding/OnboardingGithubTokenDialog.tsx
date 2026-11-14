import { AddConnectionDialog } from '../../../settings/components/connections/AddConnectionDialog';
import { useConnectors } from '../../../../../hooks/useConnections';

/** The GitHub connector's id in the server's connections catalog (ADR-0035). */
const GITHUB_CONNECTOR = 'connector:github' as const;

/**
 * A server without a GitHub App connects GitHub with a personal access token. Onboarding has no Factory
 * yet, so it opens the connections dialog straight at GitHub, the one Settings › Підключення uses.
 */
export function OnboardingGithubTokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectors(open);
  return (
    <AddConnectionDialog
      open={open}
      initialStep={GITHUB_CONNECTOR}
      sources={connectors.data ? { connectors: connectors.data.connectors } : {}}
      // Done: the connection is saved; the Codebase section reloads GitHub's status and lists its repositories.
      onPick={onClose}
      onClose={onClose}
    />
  );
}
