import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useMcpActivity } from '../../../../../hooks/useMcpServers';
import { relativeTime } from '../../../../../lib/date/relativeTime';
import { SettingsSubsection } from '../SettingsSubsection';

/**
 * «Активність»: the Factory's agents' tool calls through its connections in the last 24 hours —
 * counts, then the newest calls (when, server, tool, outcome, how long, the session). Only MCP calls
 * are in the audit trail today; the description says so instead of showing an empty Google Cloud.
 */
export function ConnectionActivity({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const activity = useMcpActivity(factoryId);
  const data = activity.data;

  return (
    <SettingsSubsection title={t('connections.activity.title')} description={t('connections.activity.description')}>
      {activity.isError ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('connections.activity.unavailable')}
        </Txt>
      ) : !data ? null : data.total === 0 ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('connections.activity.none')}
        </Txt>
      ) : (
        <div className="flex flex-col gap-3">
          <Txt as="p" variant="body" tone="ink" role="status">
            {t('connections.activity.summary', { count: data.total, errors: data.errors })}
          </Txt>
          {data.truncated && (
            <Txt as="p" variant="caption" tone="muted">
              {t('connections.activity.truncated')}
            </Txt>
          )}
          <ul aria-label={t('connections.activity.listLabel')} className="border-border1 divide-border1 divide-y rounded-lg border">
            {data.calls.map(call => (
              <li
                key={`${call.at}:${call.serverId}:${call.tool}`}
                className="flex flex-col gap-1 px-3 py-2 md:grid md:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-4 md:px-4"
              >
                <Txt as="span" variant="meta" tone="muted">
                  <time dateTime={call.at}>{relativeTime(call.at)}</time>
                </Txt>
                <Txt as="span" variant="caption" tone="ink" className="truncate">
                  {call.serverLabel}
                </Txt>
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${call.outcome === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                  <Txt as="span" variant="caption" tone="ink" className="truncate font-mono">
                    {call.tool}
                  </Txt>
                  <Txt as="span" variant="meta" tone="muted" className="shrink-0">
                    {[
                      call.outcome === 'ok' ? t('connections.activity.ok') : t('connections.activity.error'),
                      ...(call.durationMs !== undefined ? [t('mcpServers.calls.duration', { ms: call.durationMs })] : []),
                      ...(call.tried ? [t('connections.activity.tried')] : []),
                    ].join(' · ')}
                  </Txt>
                </span>
                {call.sessionId && !call.tried ? (
                  <Link className="flex min-h-11 items-center text-xs underline md:min-h-0 md:justify-self-end" to={`/factories/${factoryId}/workspaces/${call.sessionId}`}>
                    {t('connections.activity.session')}
                  </Link>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsSubsection>
  );
}
