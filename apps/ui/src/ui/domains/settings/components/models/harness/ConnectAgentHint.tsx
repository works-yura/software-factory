import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { HarnessChoice } from '../../../../../../hooks/useHarnessChoices';
import { connectorPath } from '../../../settingsSections';

/**
 * Harnesses this person cannot run yet, each with the server's reason and a link to connect its
 * agent account (ADR-0036). Renders nothing when every harness is usable.
 */
export function ConnectAgentHint({ factoryId, choices }: { factoryId?: string; choices: readonly HarnessChoice[] }) {
  const { t } = useTranslation('settings');
  const missing = choices.filter(choice => !choice.usable && choice.connector);
  if (missing.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label={t('models.harness.connectHeading')}>
      {missing.map(choice => (
        <li key={choice.descriptor.id}>
          <Txt as="span" variant="caption" tone="muted">
            {t('models.harness.notOffered', { name: choice.descriptor.label })}{' '}
            {factoryId ? (
              <Link className="underline" to={connectorPath(factoryId, choice.connector!, { connect: true })}>
                {t('models.harness.connect', { name: choice.descriptor.label })}
              </Link>
            ) : (
              choice.reason
            )}
          </Txt>
        </li>
      ))}
    </ul>
  );
}
