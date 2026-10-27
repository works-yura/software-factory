import { THEME_OPTIONS } from '@mastra/playground-ui/components/ThemeToggle';
import { useTranslation } from 'react-i18next';

/** playground-ui's theme options with labels in the interface language. */
export function useThemeOptions() {
  const { t } = useTranslation();
  return THEME_OPTIONS.map(option => ({ ...option, label: t(`theme.options.${option.value}`) }));
}
