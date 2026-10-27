import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { useTranslation } from 'react-i18next';

import { currentLanguage, LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from '.';
import type { Language } from '.';

/** Switches the interface language; the choice is remembered in this browser. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <SegmentedControl
      aria-label={t('language.label')}
      value={currentLanguage()}
      onValueChange={(value: string) => {
        if ((SUPPORTED_LANGUAGES as readonly string[]).includes(value)) void i18n.changeLanguage(value as Language);
      }}
    >
      {SUPPORTED_LANGUAGES.map(language => (
        <SegmentedControlItem key={language} value={language}>
          {LANGUAGE_NAMES[language]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
