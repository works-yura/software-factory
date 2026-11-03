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
import type { RunErrorCopy, RunErrorDescription, RunErrorRecovery } from '@factory/credentials/run-error';
import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import { ArrowRight } from 'lucide-react';
import { useContext } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';

import { settingsSectionPath } from '../../settings/settingsSections';
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

/**
 * What a harness that classifies its own failures (Claude Code: `kind`, the
 * HTTP `status`, when a limit `resetsAt`) says about an error. Read
 * defensively: older servers and Mastra errors carry none of it.
 */
interface HarnessErrorFacts {
  kind?: string;
  resetsAt?: Date;
}

function harnessErrorFacts(error: MastraErrorPart['error'], harness: HarnessDescriptor | undefined): HarnessErrorFacts {
  const raw = error as unknown as Record<string, unknown>;
  // A bare `status` names the failure only for a harness that reports its own (Mastra errors keep the provider's `statusCode`).
  const status = harness?.modelScope === 'factory' && typeof raw.status === 'number' ? raw.status : undefined;
  const kind =
    typeof raw.kind === 'string'
      ? raw.kind
      : status === 401 || status === 403
        ? 'auth'
        : status === 429
          ? 'rate_limit'
          : undefined;
  return { kind, resetsAt: dateOf(raw.resetsAt) };
}

function dateOf(value: unknown): Date | undefined {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : typeof value === 'number'
          ? new Date(value < 1e12 ? value * 1000 : value)
          : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** A harness's own failure kind, where it names one, decides the title and the fix; the rest is read from the provider error. */
function describeHarnessError(
  error: MastraErrorPart['error'],
  facts: HarnessErrorFacts,
  copy: RunErrorCopy,
): RunErrorDescription {
  const described = describeRunError(error, copy);
  switch (facts.kind) {
    case 'auth':
      return { ...described, title: copy.titles.auth, message: error.message, recoveries: ['credentials'] };
    case 'rate_limit':
      return { ...described, title: copy.titles.rateLimited, message: error.message, recoveries: ['credentials'] };
    case 'overloaded':
      return { ...described, title: copy.titles.unavailable, message: copy.messages.unavailable, recoveries: [] };
    case 'timeout':
      return { ...described, title: copy.titles.timeout, message: copy.messages.timeout, recoveries: [] };
    default:
      return described;
  }
}

/**
 * The one fix a harness whose model and credentials are the Factory's
 * (Claude Code) offers: its Models settings, where its accounts and model live.
 * The session's own model picker and the provider defaults don't apply there.
 */
function FactoryModelSettingsAction({ harness }: { harness: HarnessDescriptor }) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const session = useContext(ChatSessionContext);
  const { factoryId: routeFactoryId } = useParams<{ factoryId: string }>();
  const factoryId = session?.factorySessionState?.factoryProjectId ?? routeFactoryId;
  if (!factoryId) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      render={<Link to={settingsSectionPath(factoryId, 'models')} state={{ from: location }} />}
      iconEnd={<ArrowRight aria-hidden="true" />}
    >
      {harness.setup.claudeSignIn ? t('runError.reviewClaudeAccounts') : t('runError.openModelSettings')}
    </Button>
  );
}

/** A failed run: what went wrong in plain words, the fix where one exists, and the raw details to copy. */
export function RunErrorNotice({ error, entryId }: { error: MastraErrorPart['error']; entryId: string }) {
  const { t, i18n } = useTranslation('chat');
  const session = useContext(ChatSessionContext);
  const displayedThread = useContext(ChatThreadMessagesContext);
  const harness = session?.harness;
  const facts = harnessErrorFacts(error, harness);
  const { title, message, recoveries, model } = describeHarnessError(error, facts, useRunErrorCopy());
  const factoryScoped = harness?.modelScope === 'factory';
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
          {factoryScoped
            ? recoveries.length > 0 && <FactoryModelSettingsAction harness={harness} />
            : recoveries.map(recovery => {
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
      {facts.resetsAt && (
        <Txt variant="body-sm" tone="muted">
          {t('runError.resetsAt', {
            time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
              facts.resetsAt,
            ),
          })}
        </Txt>
      )}
      {model && (
        <Txt variant="body-sm" tone="muted">
          {t('runError.model', { model: formatModelName(model) })}
        </Txt>
      )}
    </Notice>
  );
}
