import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ClaudeCodeModel } from '@factory/harness-claude-code/models/aliases';
import { settingsSectionPath } from '../../../settings/settingsSections';

/**
 * The model of a Claude Code chat: the Factory's Claude model, changed in
 * Settings → Models for every Claude Code session from its next turn.
 */
export function ClaudeCodeModelLabel({ model, factoryId }: { model: ClaudeCodeModel | null; factoryId?: string }) {
  const { t } = useTranslation('chat');
  const { t: tw } = useTranslation('workspaces');
  const label = t('claudeCode.model', { model: tw(`createFactory.claudeCode.models.${model ?? 'default'}.title`) });
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
