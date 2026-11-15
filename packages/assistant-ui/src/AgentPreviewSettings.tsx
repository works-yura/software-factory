import { Badge } from '@mastra/playground-ui/components/Badge';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsItem, SettingsListHeader } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { MarkdownDocumentEditor } from './BehaviorSettings';
import { useModelLabel } from './RequestThread';
import { useAgentPreview } from './settings-api';
import type { AssistantToolKind } from './settings-api';

const KIND_VARIANT: Record<AssistantToolKind, 'neutral' | 'info' | 'warning'> = {
  read: 'neutral',
  write_own: 'info',
  proposal: 'warning',
};

/**
 * Settings › «Помічник» › «Що бачить агент»: read-only, exactly what a turn runs on now — the whole
 * system prompt (the base document, the skills index, the guard) and every tool with what it may do.
 */
export function AssistantAgentPreview() {
  const { t } = useTranslation('assistant');
  const preview = useAgentPreview();
  const modelLabel = useModelLabel();
  if (preview.isError) return <Notice variant="destructive">{preview.error.message}</Notice>;
  if (!preview.data) return <Skeleton className="h-40 w-full" />;
  const { data } = preview;
  return (
    <>
      <SettingsContainer>
        <div className="flex flex-col gap-3 p-4">
          <Txt as="p" variant="caption" tone="muted">
            {t('preview.promptHint', {
              version: data.version,
              model: data.modelId ? modelLabel(data.modelId) : t('failure.defaultModel'),
            })}
          </Txt>
          <MarkdownDocumentEditor value={data.systemPrompt} readOnly label={t('preview.prompt')} />
        </div>
      </SettingsContainer>
      <SettingsContainer aria-label={t('preview.tools')}>
        <SettingsListHeader>{t('preview.toolsCount', { count: data.tools.length })}</SettingsListHeader>
        {data.tools.map(tool => (
          <SettingsItem
            key={tool.name}
            data-testid={`assistant-tool-${tool.name}`}
            title={
              <span className="flex items-center gap-2">
                <code>{tool.name}</code>
                <Badge size="xs" variant={KIND_VARIANT[tool.kind]}>
                  {t(`preview.kind.${tool.kind}`)}
                </Badge>
              </span>
            }
            description={tool.description}
          />
        ))}
      </SettingsContainer>
    </>
  );
}
