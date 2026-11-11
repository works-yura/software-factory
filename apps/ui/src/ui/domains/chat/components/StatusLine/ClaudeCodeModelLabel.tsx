import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isClaudeCodeModel } from '@factory/harness-claude-code/models/aliases';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { settingsSectionPath } from '../../../settings/settingsSections';

/**
 * The model of a Claude Code chat while its catalog loads: the Factory's Claude Code default, changed in
 * Settings → Models for every Claude Code session from its next turn.
 */
export function ClaudeCodeModelLabel({ model, factoryId }: { model: string | null; factoryId?: string }) {
  const { t } = useTranslation('chat');
  const { t: tw } = useTranslation('workspaces');
  const name =
    model && !isClaudeCodeModel(model)
      ? formatModelName(model)
      : tw(`createFactory.claudeCode.models.${isClaudeCodeModel(model) ? model : 'default'}.title`);
  const label = t('claudeCode.model', { model: name });
  const hint = t('claudeCode.modelHint');
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
