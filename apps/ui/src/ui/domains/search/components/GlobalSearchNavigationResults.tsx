import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Brain, GitPullRequest, ListChecks, Settings, SquareKanban } from 'lucide-react';

import { rememberedBoardPath } from '../../factory/services/boardViews';
import type { GlobalSearchSelectHandler } from '../services/searchNavigation';
import { SETTINGS_SECTION_LABELS, settingsSectionPath } from '../../settings/settingsSections';
import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../i18n';

/**
 * Command-palette match text. Outside English, the shown (translated) title and
 * subtitle lead, and the English keywords stay so either language finds the page.
 */
function searchValue(title: string, subtitle: string, keywords: string): string {
  return currentLanguage() === 'en' ? keywords : `${title} ${subtitle} ${keywords}`;
}

export function GlobalSearchNavigationResults({
  factoryId,
  onSelect,
}: {
  factoryId: string;
  onSelect: GlobalSearchSelectHandler;
}) {
  const { t } = useTranslation('search');
  return (
    <CommandGroup heading={t('scopes.navigation')}>
      <CommandPaletteItem
        icon={<SquareKanban />}
        title={t('navigation.work')}
        subtitle={t('subtitles.factory')}
        value={searchValue(t('navigation.work'), t('subtitles.factory'), `Work Factory navigation /factories/${factoryId}/work`)}
        onSelect={() => onSelect(rememberedBoardPath(factoryId, 'work'), false)}
      />
      <CommandPaletteItem
        icon={<GitPullRequest />}
        title={t('navigation.review')}
        subtitle={t('subtitles.factory')}
        value={searchValue(t('navigation.review'), t('subtitles.factory'), `Review Factory navigation /factories/${factoryId}/review`)}
        onSelect={() => onSelect(rememberedBoardPath(factoryId, 'review'), false)}
      />
      <CommandPaletteItem
        icon={<ListChecks />}
        title={t('navigation.rules')}
        subtitle={t('subtitles.factory')}
        value={searchValue(t('navigation.rules'), t('subtitles.factory'), `Rules Factory navigation /factories/${factoryId}/rules`)}
        onSelect={() => onSelect(`/factories/${factoryId}/rules`, false)}
      />
      <CommandPaletteItem
        icon={<Brain />}
        title={t('navigation.knowledge')}
        subtitle={t('subtitles.factory')}
        value={searchValue(t('navigation.knowledge'), t('subtitles.factory'), `Knowledge Factory navigation /factories/${factoryId}/knowledge`)}
        onSelect={() => onSelect(`/factories/${factoryId}/knowledge`, false)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.preferences}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.preferences, t('subtitles.settings'), `Preferences Settings preferences ${settingsSectionPath(factoryId, 'preferences')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'preferences'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.factory}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.factory, t('subtitles.settings'), `Factory Settings factory ${settingsSectionPath(factoryId, 'factory')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'factory'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.connections}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.connections, t('subtitles.settings'), `Connections Settings connections ${settingsSectionPath(factoryId, 'connections')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'connections'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.repositories}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.repositories, t('subtitles.settings'), `Repositories Settings repositories ${settingsSectionPath(factoryId, 'repositories')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'repositories'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.intake}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.intake, t('subtitles.settings'), `Work Intake Settings intake ${settingsSectionPath(factoryId, 'intake')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'intake'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.models}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.models, t('subtitles.settings'), `Models Settings models factory defaults providers ${settingsSectionPath(factoryId, 'models')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'models'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.memory}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.memory, t('subtitles.settings'), `Memory Settings memory factory shared observational ${settingsSectionPath(factoryId, 'memory')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'memory'), true)}
      />
      <CommandPaletteItem
        icon={<Settings />}
        title={SETTINGS_SECTION_LABELS.behavior}
        subtitle={t('subtitles.settings')}
        value={searchValue(SETTINGS_SECTION_LABELS.behavior, t('subtitles.settings'), `Behavior Settings behavior ${settingsSectionPath(factoryId, 'behavior')}`)}
        onSelect={() => onSelect(settingsSectionPath(factoryId, 'behavior'), true)}
      />
    </CommandGroup>
  );
}
