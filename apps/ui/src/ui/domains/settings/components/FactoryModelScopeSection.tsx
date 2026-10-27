import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useFactoryProjectQuery, useSetFactoryModelScopeMutation } from '../../../../hooks/useFactoryDefaultModel';
import type { FactoryModelScope } from '../../workspaces/services/github';

const MODEL_SCOPES: readonly FactoryModelScope[] = ['hybrid', 'factory', 'user'];

function isModelScope(value: string): value is FactoryModelScope {
  return (MODEL_SCOPES as readonly string[]).includes(value);
}

export function FactoryModelScopeSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const projectQuery = useFactoryProjectQuery(factoryId);
  const setModelScope = useSetFactoryModelScopeMutation(factoryId);

  if (!factoryId) return null;

  const modelScope = projectQuery.data?.modelScope ?? 'hybrid';
  const error = setModelScope.error ?? projectQuery.error;

  const saveModelScope = (value: string) => {
    if (!isModelScope(value)) return;
    if (value === modelScope) return;
    setModelScope.mutate(value);
  };

  return (
    <SettingsRow
      label={t('models.scope.label')}
      description={
        <>
          <span>{t('models.scope.description')}</span>
          {error && (
            <Txt as="span" variant="meta" className="text-destructive-foreground">
              {error instanceof Error ? error.message : String(error)}
            </Txt>
          )}
        </>
      }
    >
      <div className="flex items-center gap-2">
        {setModelScope.isPending && (
          <Spinner size="sm" aria-label={t('models.scope.saving')} className="text-muted-foreground shrink-0" />
        )}
        <Select
          value={modelScope}
          disabled={projectQuery.isPending || setModelScope.isPending}
          onValueChange={saveModelScope}
        >
          <SelectTrigger size="sm" aria-label={t('models.scope.label')} className="w-72">
            <Txt as="span" variant="caption">
              {t(`models.scope.options.${modelScope}`)}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {MODEL_SCOPES.map(scope => (
              <SelectItem key={scope} value={scope}>
                {t(`models.scope.options.${scope}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingsRow>
  );
}
