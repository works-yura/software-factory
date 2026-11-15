import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import {
  SettingsItem,
  SettingsItemIcon,
  SettingsListHeader,
  SettingsNoticeRow,
  SettingsSkeleton,
} from '@mastra/playground-ui/new/settings';
import { Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CustomProviderInfo } from '../../../../api/types';
import {
  useCustomProvidersQuery,
  useRemoveCustomProvider,
  useSaveCustomProvider,
} from '../../../../hooks/use-custom-providers';

interface DraftState {
  /** id of the provider being edited, or '' for a brand-new one. */
  editingId: string;
  name: string;
  url: string;
  apiKey: string;
  models: string;
}

const EMPTY_DRAFT: DraftState = { editingId: '', name: '', url: '', apiKey: '', models: '' };

/**
 * Custom OpenAI-compatible providers. Mirrors the TUI's `/custom-providers`
 * command. Backed by global settings (settings.json) on the server, not session
 * state — these are user-global endpoint definitions (name + base URL + optional
 * key + model list). Keys are write-only; the server reports only their presence.
 */
export function CustomProvidersSection() {
  const { t } = useTranslation('settings');
  const providersQuery = useCustomProvidersQuery();
  const saveMutation = useSaveCustomProvider();
  const removeMutation = useRemoveCustomProvider();

  const [draftError, setDraftError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  const providers = providersQuery.data ?? [];
  const loading = providersQuery.isPending;
  const busy = saveMutation.isPending || removeMutation.isPending;
  const queryError = providersQuery.error instanceof Error ? providersQuery.error.message : null;
  const error = draftError ?? queryError;

  const startAdd = () => {
    setDraftError(null);
    setDraft({ ...EMPTY_DRAFT });
  };
  const startEdit = (p: CustomProviderInfo) =>
    setDraft({ editingId: p.id, name: p.name, url: p.url, apiKey: '', models: p.models.join(', ') });

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) {
      setDraftError(t('customProviders.nameAndUrlRequired'));
      return;
    }
    const models = draft.models
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    const apiKey = draft.apiKey.trim();
    setDraftError(null);
    try {
      await saveMutation.mutateAsync({
        name,
        url,
        models,
        ...(apiKey ? { apiKey } : {}),
        ...(draft.editingId ? { previousId: draft.editingId } : {}),
      });
      setDraft(null);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setDraftError(null);
    try {
      await removeMutation.mutateAsync({ id });
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    }
  };

  const addButton = !draft && (
    <Button size="sm" onClick={startAdd} disabled={busy}>
      <Plus aria-hidden="true" /> {t('customProviders.add')}
    </Button>
  );

  // Rows of the `SettingsContainer` the caller puts it in: the list's caption and action, the
  // providers as items, the add/edit form, and any error.
  return (
    <>
      <SettingsListHeader action={addButton || undefined}>
        <span className="text-body-sm text-muted-foreground">{t('customProviders.description')}</span>
      </SettingsListHeader>

      {draft && (
        <div className="flex flex-col gap-3">
          <Field className="gap-1">
            <FieldLabel>{t('customProviders.name')}</FieldLabel>
            <Input
              size="sm"
              placeholder={t('customProviders.namePlaceholder')}
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel>{t('customProviders.baseUrl')}</FieldLabel>
            <Input
              size="sm"
              placeholder="https://api.example.com/v1"
              value={draft.url}
              onChange={e => setDraft({ ...draft, url: e.target.value })}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel>
              {draft.editingId ? t('customProviders.apiKeyKeep') : t('customProviders.apiKeyOptional')}
            </FieldLabel>
            <Input
              type="password"
              size="sm"
              placeholder={t('customProviders.apiKeyPlaceholder')}
              value={draft.apiKey}
              onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel>{t('customProviders.models')}</FieldLabel>
            <Input
              size="sm"
              placeholder="model-a, model-b"
              value={draft.models}
              onChange={e => setDraft({ ...draft, models: e.target.value })}
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => setDraft(null)}>
              {t('customProviders.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {draft.editingId ? t('customProviders.save') : t('customProviders.addShort')}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <SettingsSkeleton label={t('customProviders.loading')} rows={2} variant="item" />
      ) : (
        providers.map(p => (
          <SettingsItem
            key={p.id}
            media={
              <SettingsItemIcon>
                <Server />
              </SettingsItemIcon>
            }
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate" title={p.name}>
                  {p.name}
                </span>
                {p.hasApiKey && (
                  <Badge size="sm" variant="success" className="shrink-0">
                    {t('credentials.keySaved')}
                  </Badge>
                )}
              </span>
            }
            description={
              <>
                <span title={p.url}>{p.url}</span>
                {p.models.length > 0 && <span> · {t('customProviders.modelCount', { count: p.models.length })}</span>}
              </>
            }
          >
            <Button size="sm" disabled={busy} onClick={() => startEdit(p)}>
              {t('customProviders.edit')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void remove(p.id)}>
              {t('customProviders.remove')}
            </Button>
          </SettingsItem>
        ))
      )}

      <SettingsNoticeRow>
        {error && (
          <Notice variant="destructive" role="alert">
            {error}
          </Notice>
        )}
      </SettingsNoticeRow>
    </>
  );
}
