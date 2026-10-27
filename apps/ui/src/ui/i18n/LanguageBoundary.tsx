import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Remounts the app when the language changes, so copy computed outside React
 * hooks (static label helpers, cached view models) is rebuilt in the new
 * language. Switching language is rare and the query cache lives above this.
 */
export function LanguageBoundary({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <div key={i18n.resolvedLanguage} className="contents">{children}</div>;
}
