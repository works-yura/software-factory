import type { MastraErrorPart } from '@mastra/core/agent/message-list';
import { Button } from '@mastra/playground-ui/components/Button';
import { CodeBlock } from '@mastra/playground-ui/components/CodeBlock';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mastra/playground-ui/components/Dialog';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { describeRunError } from '@factory/credentials/run-error';
import type { RunErrorCopy, RunErrorRecovery } from '@factory/credentials/run-error';
import { useContext } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatSessionContext } from '../context/ChatSessionContext';
import { ChatThreadMessagesContext } from '../context/ChatThreadMessagesContext';
import { ProviderLoginAction } from './ProviderLoginAction';
import { ChangeModelAction } from './StatusLine/ModelPicker';

const RECOVERY_ACTIONS: Record<RunErrorRecovery, ComponentType> = {
  credentials: ProviderLoginAction,
  model: ChangeModelAction,
};

function useRunErrorCopy(): RunErrorCopy {
  const { t } = useTranslation('chat');
  return {
    titles: {
      signIn: t('runError.titles.signIn'),
      quota: t('runError.titles.quota'),
      auth: t('runError.titles.auth'),
      contextOverflow: t('runError.titles.contextOverflow'),
      modelRejected: t('runError.titles.modelRejected'),
      toolHistoryRejected: t('runError.titles.toolHistoryRejected'),
      invalidRequest: t('runError.titles.invalidRequest'),
      timeout: t('runError.titles.timeout'),
      rateLimited: t('runError.titles.rateLimited'),
      unavailable: t('runError.titles.unavailable'),
      modelRequestFailed: t('runError.titles.modelRequestFailed'),
      runStopped: t('runError.titles.runStopped'),
    },
    messages: {
      quotaNext: t('runError.messages.quotaNext'),
      authNext: t('runError.messages.authNext'),
      contextOverflow: t('runError.messages.contextOverflow'),
      modelRejectedNext: t('runError.messages.modelRejectedNext'),
      modelRejectedFallback: t('runError.messages.modelRejectedFallback'),
      toolHistoryRejected: t('runError.messages.toolHistoryRejected'),
      timeout: t('runError.messages.timeout'),
      rateLimited: t('runError.messages.rateLimited'),
      unavailable: t('runError.messages.unavailable'),
      noReason: t('runError.messages.noReason'),
      unexpected: t('runError.messages.unexpected'),
    },
  };
}

/** A failed run: what went wrong in plain words, the fix where one exists, and the raw details to copy. */
export function RunErrorNotice({ error, entryId }: { error: MastraErrorPart['error']; entryId: string }) {
  const { t } = useTranslation('chat');
  const session = useContext(ChatSessionContext);
  const displayedThread = useContext(ChatThreadMessagesContext);
  const { title, message, recoveries, model } = describeRunError(error, useRunErrorCopy());
  const diagnostics = JSON.stringify(
    {
      ...error,
      entryId,
      sessionId: session?.sessionId,
      resourceId: session?.resourceId,
      threadId: displayedThread?.threadId ?? session?.sessionThreadId,
    },
    undefined,
    2,
  );
  return (
    <Notice
      variant="destructive"
      title={title}
      action={
        <>
          {recoveries.map(recovery => {
            const RecoveryAction = RECOVERY_ACTIONS[recovery];
            return <RecoveryAction key={recovery} />;
          })}
          <Dialog>
            <DialogTrigger
              render={
                <Button variant="ghost" size="sm" className="ms-auto">
                  {t('runError.details')}
                </Button>
              }
            />
            <DialogContent size="lg">
              <DialogHeader>
                <DialogTitle>{t('runError.details')}</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <CodeBlock code={diagnostics} lang="json" copyTooltip={t('runError.copyDetails')} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </>
      }
    >
      <Notice.Message>{message}</Notice.Message>
      {model && (
        <Txt variant="body-sm" tone="muted">
          {t('runError.model', { model: formatModelName(model) })}
        </Txt>
      )}
    </Notice>
  );
}
