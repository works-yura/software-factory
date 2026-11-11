import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import { isClaudeCodeModel } from '@factory/harness-claude-code/models/aliases';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { settingsSectionPath } from '../../../settings/settingsSections';

/** How a Factory default reads: a Claude CLI alias by its title, a catalog slug formatted, none as the harness's own default. */
function modelName(harness: Pick<HarnessDescriptor, 'id'> | undefined, model: string | null, t: (key: string) => string): string {
  if (model && !isClaudeCodeModel(model)) return formatModelName(model);
  if (harness?.id === 'codex') return t('createFactory.codex.models.default.title');
  return t(`createFactory.claudeCode.models.${isClaudeCodeModel(model) ? model : 'default'}.title`);
}

/**
 * The model of a chat on a turn-based harness (Claude Code, Codex) while its catalog loads: the
 * Factory's default for that harness, changed in Settings → Models for every such session from its
 * next turn.
 */
export function FactoryHarnessModelLabel({
  harness,
  model,
  factoryId,
}: {
  harness: Pick<HarnessDescriptor, 'id' | 'label'> | undefined;
  model: string | null;
  factoryId?: string;
}) {
  const { t } = useTranslation('chat');
  const { t: tw } = useTranslation('workspaces');
  const harnessLabel = harness?.label ?? 'Claude Code';
  const label = t('turnHarness.model', { harness: harnessLabel, model: modelName(harness, model, key => tw(key as never)) });
  const hint = t('turnHarness.modelHint', { harness: harnessLabel });
  if (!factoryId) {
    return (
      <span className="text-muted-foreground" title={hint}>
        {label}
      </span>
    );
  }
  return (
    <Link
      to={settingsSectionPath(factoryId, 'models')}
      title={hint}
      aria-label={`${label}. ${hint}`}
      className="text-muted-foreground hover:text-foreground"
    >
      {label}
    </Link>
  );
}
