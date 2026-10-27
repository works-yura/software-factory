import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LinearIcon } from '@mastra/playground-ui/icons/LinearIcon';
import { useLinearStatusQuery } from '../../../../../hooks/useLinearData';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { OnboardingConnectionRow } from './OnboardingConnectionRow';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export function OnboardingLinearConnection({ onConnect }: { onConnect: () => void }) {
  const query = useLinearStatusQuery();
  if (query.isPending)
    return <SkeletonRows label={tk('connections.loadingLinear')} rows={1} rowClassName="h-22 w-full" />;
  const status = query.data;
  if (status?.connected)
    return (
      <OnboardingConnectionRow
        compact
        icon={<LinearIcon />}
        name="Linear"
        description={tk('connections.connectedTo', { account: status.workspace?.name ?? 'Linear' })}
        action={
          <Txt as="span" variant="caption" tone="muted" className="me-3">
            {tk('providers.connected')}
          </Txt>
        }
      />
    );
  if (status?.reason === 'missing_config')
    return (
      <OnboardingConnectionRow
        compact
        icon={<LinearIcon />}
        name="Linear"
        description={tk('vcs.gitlabUnavailable.missing_config')}
      />
    );
  if (status?.reason === 'organization_required')
    return (
      <OnboardingConnectionRow
        compact
        icon={<LinearIcon />}
        name="Linear"
        description={tk('connections.linearOrganizationRequired')}
      />
    );
  if (status?.reason === 'auth_required')
    return (
      <OnboardingConnectionRow
        compact
        icon={<LinearIcon />}
        name="Linear"
        description={tk('connections.linearExpired')}
        action={
          <Button size="sm" aria-label={tk('createFactory.linear.reconnect')} onClick={onConnect}>
            {tk('connections.reconnect')}
          </Button>
        }
      />
    );
  if (status?.reason === 'not_connected')
    return (
      <OnboardingConnectionRow
        compact
        icon={<LinearIcon />}
        name="Linear"
        description={tk('connections.workPurpose')}
        action={
          <Button size="sm" aria-label={tk('vcs.connect', { host: 'Linear' })} onClick={onConnect}>
            {tk('connections.connect')}
          </Button>
        }
      />
    );
  return (
    <OnboardingConnectionRow
      compact
      icon={<LinearIcon />}
      name="Linear"
      description={tk('connections.linearLoadError')}
      action={
        <Button
          variant="ghost"
          size="sm"
          aria-label={tk('connections.retryNamed', { name: 'Linear' })}
          onClick={() => void query.refetch()}
        >
          {tk('actions.retry')}
        </Button>
      }
    />
  );
}
