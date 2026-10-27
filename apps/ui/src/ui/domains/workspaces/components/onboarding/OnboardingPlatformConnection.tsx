import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { usePlatformConnectionsQuery } from '../../../../../hooks/usePlatformConnections';
import { isPlatformConnectUnavailableError } from '../../../factory/services/platformConnect';
import { ProviderConnectControl } from '../../../settings/components/PlatformProviderConnections';
import { IncidentIoIcon, JiraIcon } from '../../../../ui/icons';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { WORK_SOURCE_NAME } from '../../hooks/useWorkSourceConnections';
import { OnboardingConnectionRow } from './OnboardingConnectionRow';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

const PLATFORMS = {
  jira: { Icon: JiraIcon, purposeKey: 'connections.workPurpose' },
  'incident-io': { Icon: IncidentIoIcon, purposeKey: 'connections.incidentPurpose' },
} as const;

export function OnboardingPlatformConnection({ provider }: { provider: 'jira' | 'incident-io' }) {
  const query = usePlatformConnectionsQuery(provider);
  const name = WORK_SOURCE_NAME[provider];
  const { Icon, purposeKey } = PLATFORMS[provider];
  if (query.isPending)
    return <SkeletonRows label={tk('connections.loadingNamed', { name })} rows={1} rowClassName="h-22 w-full" />;
  if (isPlatformConnectUnavailableError(query.error)) return null;
  const active = query.data?.filter(connection => connection.status === 'active') ?? [];
  if (active.length) {
    const description =
      active.length === 1
        ? tk('connections.connectedTo', { account: active[0]?.accountLabel ?? name })
        : tk('connections.accountsConnected', { count: active.length });
    return (
      <OnboardingConnectionRow
        compact
        icon={<Icon />}
        name={name}
        description={description}
        action={
          <Txt as="span" variant="caption" tone="muted" className="me-3">
            {tk('providers.connected')}
          </Txt>
        }
      />
    );
  }
  if (query.isError) {
    return (
      <OnboardingConnectionRow
        compact
        icon={<Icon />}
        name={name}
        description={tk('connections.loadErrorNamed', { name })}
        action={
          <Button
            variant="ghost"
            size="sm"
            aria-label={tk('connections.retryNamed', { name })}
            onClick={() => void query.refetch()}
          >
            {tk('actions.retry')}
          </Button>
        }
      />
    );
  }
  const reconnect = query.data?.find(connection => connection.status === 'needs_reauth');
  const description = reconnect ? tk('connections.reconnectHint') : tk(purposeKey);
  return (
    <OnboardingConnectionRow
      compact
      icon={<Icon />}
      name={name}
      description={description}
      action={
        <ProviderConnectControl
          provider={provider}
          label={reconnect ? tk('connections.reconnectNamed', { name }) : tk('vcs.connect', { host: name })}
          buttonLabel={reconnect ? tk('connections.reconnect') : tk('connections.connect')}
          reconnectConnectionId={reconnect?.id}
          size="sm"
        />
      }
    />
  );
}
