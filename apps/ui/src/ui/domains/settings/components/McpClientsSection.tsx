import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useApiConfig } from '../../../../api/config';
import { useServerFeatures } from '../../../../hooks/useServerFeatures';

import { SettingsSubsection } from './SettingsSubsection';

/** The Factory's MCP endpoint. The web app calls the API same-origin (`baseUrl` is `''`). */
export function factoryMcpUrl(baseUrl: string, factoryId: string): string {
  return `${baseUrl || window.location.origin}/web/factory/projects/${encodeURIComponent(factoryId)}/mcp`;
}

function ConnectStep({ children }: { children: string }) {
  return (
    <Txt tone="muted" as="span" variant="caption">
      {children}
    </Txt>
  );
}

/** Shown only when the server mounts the MCP endpoint (auth plus an OAuth server for MCP clients). */
export function McpClientsSection() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const { baseUrl } = useApiConfig();
  const features = useServerFeatures();
  const { t } = useTranslation('settings');

  if (!factoryId || !features.data?.mcp) return null;
  const url = factoryMcpUrl(baseUrl, factoryId);

  return (
    <SettingsSubsection scope="personal" title={t('mcp.title')} description={t('mcp.description')}>
      <SettingsContainer>
        <SettingsRow label={t('mcp.url')}>
          <div className="flex min-w-0 items-center gap-1">
            <Txt tone="muted" as="span" variant="caption" font="mono" className="truncate">
              {url}
            </Txt>
            <CopyButton content={url} size="icon-sm" variant="ghost" tooltip={t('mcp.copy')} />
          </div>
        </SettingsRow>
        <SettingsRow label="Claude">
          <ConnectStep>{t('mcp.claude')}</ConnectStep>
        </SettingsRow>
        <SettingsRow label="Claude Code">
          <ConnectStep>{t('mcp.claudeCode')}</ConnectStep>
        </SettingsRow>
        <SettingsRow label="ChatGPT">
          <ConnectStep>{t('mcp.chatgpt')}</ConnectStep>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
