import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { ApiRequestError } from '../../../../api/client';
import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useServerFeatures } from '../../../../hooks/useServerFeatures';

/** One of the person's own OpenCode sessions, as `/web/opencode/local-sessions` lists it. */
export interface OpenCodeLocalSession {
  id: string;
  title: string;
  directory: string;
  worktree?: string;
  updatedAt: string;
  messages: number;
  repositorySlug?: string;
  /** The Factory repository its folder is a clone of, when the Factory has it. */
  projectRepositoryId?: string;
}

interface LocalSessionsResponse {
  sessions: OpenCodeLocalSession[];
  repositories: Array<{ projectRepositoryId: string; slug: string }>;
}

const message = (error: unknown) => (error instanceof ApiRequestError ? (error.detail ?? error.message) : error instanceof Error ? error.message : String(error));

/**
 * "Continue an OpenCode session": the person's own OpenCode sessions on this machine (the server
 * reads them read-only, at their request), each continued as a new Factory session on the OpenCode
 * harness, on the repository its folder is a clone of or one they pick. Only on a server that is the
 * person's own machine (`opencodeLocalSessions`).
 */
export function OpenCodeImportButton() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const features = useServerFeatures();
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  if (!factoryId || features.data?.opencodeLocalSessions !== true) return null;
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={t('openCodeImport.open')} tooltip={t('openCodeImport.open')} onClick={() => setOpen(true)}>
        <History aria-hidden />
      </Button>
      {open && <OpenCodeImportDialog factoryId={factoryId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function OpenCodeImportDialog({ factoryId, onClose }: { factoryId: string; onClose: () => void }) {
  const { client } = useApiConfig();
  const { t, i18n } = useTranslation('workspaces');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: ['opencode-local-sessions', factoryId],
    queryFn: () => client.get<LocalSessionsResponse>(`/web/opencode/local-sessions?factoryProjectId=${encodeURIComponent(factoryId)}`),
    retry: false,
  });
  const importing = useMutation({
    mutationFn: ({ session, projectRepositoryId }: { session: OpenCodeLocalSession; projectRepositoryId: string }) =>
      client.post<{ session: { sessionId: string } }>(`/web/opencode/local-sessions/${encodeURIComponent(session.id)}/import`, {
        projectRepositoryId,
        visibility: 'private',
      }),
    onSuccess: ({ session }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions(factoryId) });
      onClose();
      void navigate(`/factories/${factoryId}/user/threads/${session.sessionId}`);
    },
  });
  const repositories = list.data?.repositories ?? [];
  const formatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Dialog open onOpenChange={next => !next && onClose()} pending={importing.isPending}>
      <DialogContent size="lg" aria-label={t('openCodeImport.title')}>
        <DialogHeader>
          <DialogTitle>{t('openCodeImport.title')}</DialogTitle>
          <DialogDescription>{t('openCodeImport.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {list.isPending && (
            <div className="flex items-center gap-2" role="status">
              <Spinner size="sm" />
              <Txt as="span" variant="caption" tone="muted">
                {t('openCodeImport.loading')}
              </Txt>
            </div>
          )}
          {list.isError && <Notice variant="destructive">{message(list.error)}</Notice>}
          {importing.isError && <Notice variant="destructive">{message(importing.error)}</Notice>}
          {list.data && list.data.sessions.length === 0 && <EmptyState iconSlot={null} titleSlot={t('openCodeImport.empty')} />}
          {list.data && list.data.sessions.length > 0 && (
            <ScrollArea className="max-h-[60vh]">
              <ul className="flex flex-col divide-y divide-border" aria-label={t('openCodeImport.listLabel')}>
                {list.data.sessions.map(session => {
                  const repository = picked[session.id] ?? session.projectRepositoryId ?? '';
                  return (
                    <li key={session.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-col">
                        <Txt as="span" variant="body-sm" className="truncate">
                          {session.title}
                        </Txt>
                        <Txt as="span" variant="caption" tone="muted" className="truncate" title={session.directory}>
                          {session.directory}
                        </Txt>
                        <Txt as="span" variant="caption" tone="muted">
                          {t('openCodeImport.meta', { count: session.messages, updated: formatter.format(new Date(session.updatedAt)) })}
                          {!session.projectRepositoryId && ` · ${session.repositorySlug ? t('openCodeImport.otherRepository', { slug: session.repositorySlug }) : t('openCodeImport.noRepository')}`}
                        </Txt>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Select value={repository} onValueChange={value => setPicked(current => ({ ...current, [session.id]: value }))}>
                          <SelectTrigger size="sm" aria-label={t('openCodeImport.repositoryFor', { title: session.title })} className="w-44">
                            {repositories.find(choice => choice.projectRepositoryId === repository)?.slug ?? t('openCodeImport.pickRepository')}
                          </SelectTrigger>
                          <SelectContent>
                            {repositories.map(choice => (
                              <SelectItem key={choice.projectRepositoryId} value={choice.projectRepositoryId}>
                                {choice.slug}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="default"
                          disabled={!repository || importing.isPending}
                          onClick={() => importing.mutate({ session, projectRepositoryId: repository })}
                        >
                          {t('openCodeImport.continue')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}
          <Txt as="p" variant="caption" tone="muted">
            {t('openCodeImport.note')}
          </Txt>
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('actions.cancel')}</DialogCancel>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
