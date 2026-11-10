import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { InlineCode } from '@mastra/playground-ui/components/InlineCode';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Trans, useTranslation } from 'react-i18next';

import { useServerVersions } from '../../../../hooks/useServerVersions';
import type { ServerVersions } from '../../../../hooks/useServerVersions';
import { SettingsSubsection } from './SettingsSubsection';

/** Plain-text version list, for pasting into an issue or a session. */
export function formatVersions({ packages, nodeVersion }: ServerVersions): string {
  return [...packages.map(({ name, version }) => `${name}@${version}`), `node@${nodeVersion}`].join('\n');
}

function VersionValue({ children }: { children: string }) {
  return (
    <Txt tone="muted" as="span" variant="caption" font="mono" className="truncate tabular-nums">
      {children}
    </Txt>
  );
}

export function DebugSection() {
  const { t } = useTranslation('settings');
  const query = useServerVersions();

  return (
    <SettingsSubsection
      scope="deployment"
      title={t('debug.title')}
      description={t('debug.description')}
      action={
        query.data && (
          <CopyButton
            content={formatVersions(query.data)}
            tooltip={t('debug.copy')}
            variant="ghost"
            size="icon-sm"
            showToast={false}
          />
        )
      }
    >
      {query.isPending ? (
        <Txt tone="muted" as="p" variant="caption" role="status">
          {t('debug.loading')}
        </Txt>
      ) : query.isError ? (
        <div className="flex items-center gap-3">
          <Txt as="p" variant="caption" className="text-destructive-foreground">
            {t('debug.loadFailed')}
          </Txt>
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
            {t('debug.retry')}
          </Button>
        </div>
      ) : (
        <>
          {query.data.packages.length === 0 && (
            <Txt as="p" variant="caption" tone="muted" className="mb-3">
              <Trans t={t} i18nKey="debug.noPackages" components={{ code: <InlineCode /> }} />
            </Txt>
          )}
          <SettingsContainer>
            {query.data.packages.map(({ name, version }) => (
              <SettingsRow key={name} label={name}>
                <VersionValue>{version}</VersionValue>
              </SettingsRow>
            ))}
            <SettingsRow label="Node.js">
              <VersionValue>{query.data.nodeVersion}</VersionValue>
            </SettingsRow>
          </SettingsContainer>
        </>
      )}
    </SettingsSubsection>
  );
}
