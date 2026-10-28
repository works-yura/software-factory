import { Crumb } from '@mastra/playground-ui/components/Breadcrumb';
import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Bot, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';

import { FolderIcon } from '../ui/icons';
import { useFactoryQuery } from '../../hooks/useFactories';
import { useFactoryProjectQuery } from '../../hooks/useFactoryDefaultModel';
import { useFallbackModelQuery } from '../../hooks/useAvailableModels';
import { useProvidersQuery } from '../../hooks/use-providers';
import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import { useServerFeatures } from '../../hooks/useServerFeatures';
import { useUserSessionQuery } from '../../hooks/useWorkspaces';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { MODEL_DEFAULTS_ANCHORS, settingsSectionPath } from '../domains/settings/settingsSections';
import type { FactoryProject } from '../domains/workspaces/services/github';
import { ChatPageLayout } from '../domains/chat/components/ChatPageLayout';
import { ComposerPanel } from '../domains/chat/components/ComposerPanel';
import { TranscriptEntries } from '../domains/chat/components/Transcript';
import { ChatSessionBoundary } from '../domains/chat/context/ChatSessionProvider';
import { useChatTranscript } from '../domains/chat/context/useChatTranscript';
import { useGlobalShortcuts } from '../domains/chat/hooks/useGlobalShortcuts';
import { Txt } from '@mastra/playground-ui/components/Txt';

const draftStartClass = 'flex min-w-0 w-full max-w-xl flex-col items-stretch gap-6';

export function NewPage() {
  const { t } = useTranslation('chat');
  const { factoryId, draftSessionId } = useParams<{ factoryId: string; draftSessionId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const activeFactory = factoryQuery.data;
  const projectQuery = useFactoryProjectQuery(activeFactory?.id);
  const providersQuery = useProvidersQuery();
  const defaultModelId = projectQuery.data?.defaultModelId ?? undefined;
  // A Claude Code Factory's chats run on its Claude model, so no Mastra model or provider key is asked for.
  const claudeCode = (projectQuery.data?.harness ?? activeFactory?.harness) === 'claude-code';
  // No Factory default: chats start on the built-in model the organization's keys can run, as the server picks.
  const fallbackModelQuery = useFallbackModelQuery({
    factoryProjectId: activeFactory?.id,
    enabled: projectQuery.isSuccess && !defaultModelId && !claudeCode,
  });
  const chatModelId = defaultModelId ?? fallbackModelQuery.data;
  const chatModelSettled =
    !claudeCode &&
    Boolean(activeFactory) &&
    projectQuery.isSuccess &&
    (Boolean(defaultModelId) || fallbackModelQuery.isSuccess);
  const missingModel = chatModelSettled && !chatModelId;
  const chatModelProvider = chatModelId
    ? providersQuery.data?.find(entry => entry.provider === chatModelId.split('/')[0])
    : undefined;
  const missingCredential =
    chatModelSettled && chatModelId && chatModelProvider?.source === 'none'
      ? { modelId: chatModelId, provider: chatModelProvider.provider }
      : undefined;
  const configurationError = claudeCode
    ? (projectQuery.error ?? undefined)
    : (projectQuery.error ?? (defaultModelId ? null : fallbackModelQuery.error) ?? providersQuery.error ?? undefined);

  return (
    <ChatPageLayout
      crumbs={
        <>
          <Crumb as="span">{t('newPage.userSessions')}</Crumb>
          <Crumb as="span" isCurrent>
            {t('newPage.newSession')}
          </Crumb>
        </>
      }
    >
      {/* Remount only the chat content per draft, never the app shell. */}
      <ChatSessionBoundary key={draftSessionId}>
        <NewPageContent
          activeFactory={activeFactory}
          claudeCode={claudeCode}
          missingModel={missingModel}
          missingCredential={missingCredential}
          configurationError={configurationError}
        />
      </ChatSessionBoundary>
    </ChatPageLayout>
  );
}

interface MissingCredentialGuard {
  modelId: string;
  provider: string;
}

function readRouteErrorNotice(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('routeErrorNotice' in state)) return undefined;
  const { routeErrorNotice } = state;
  return typeof routeErrorNotice === 'string' ? routeErrorNotice : undefined;
}

function NewPageContent({
  activeFactory,
  claudeCode,
  missingModel,
  missingCredential,
  configurationError,
}: {
  activeFactory: FactoryProject | undefined;
  claudeCode: boolean;
  missingModel: boolean;
  missingCredential: MissingCredentialGuard | undefined;
  configurationError: Error | undefined;
}) {
  useGlobalShortcuts();
  const { transcript } = useChatTranscript();
  const location = useLocation();
  const routeErrorNotice = readRouteErrorNotice(location.state);
  const noticeEntries = transcript.entries.filter(entry => entry.kind === 'notice');
  const hasNotices = Boolean(routeErrorNotice) || noticeEntries.length > 0;

  return (
    <div className="grid min-h-full place-items-center px-4 py-10 md:px-6">
      <div className="flex w-full max-w-xl min-w-0 flex-col items-center gap-4">
        <DraftStart
          activeFactory={activeFactory}
          claudeCode={claudeCode}
          configurationError={configurationError}
          missingModel={missingModel}
          missingCredential={missingCredential}
        />
        {hasNotices && (
          <div className="flex w-full flex-col gap-4">
            {routeErrorNotice && <Notice variant="destructive">{routeErrorNotice}</Notice>}
            <TranscriptEntries entries={noticeEntries} onApprove={() => undefined} onRespond={() => undefined} />
          </div>
        )}
      </div>
    </div>
  );
}

function DraftStart({
  activeFactory,
  claudeCode,
  configurationError,
  missingModel,
  missingCredential,
}: {
  activeFactory: FactoryProject | undefined;
  claudeCode: boolean;
  configurationError: Error | undefined;
  missingModel: boolean;
  missingCredential: MissingCredentialGuard | undefined;
}) {
  const { t } = useTranslation('chat');
  const features = useServerFeatures();
  if (activeFactory && claudeCode) {
    const blocker = claudeCodeBlocker(activeFactory, features.data?.claudeCode);
    if (blocker) {
      return (
        <section className={draftStartClass} aria-label={t('newPage.claudeCode.setupRequired')}>
          <ClaudeCodeBlockedState factoryId={activeFactory.id} blocker={blocker} />
        </section>
      );
    }
  }
  if (activeFactory && missingModel) {
    return (
      <section className={draftStartClass} aria-label={t('newPage.modelSetupRequired')}>
        <MissingModelState factoryId={activeFactory.id} />
      </section>
    );
  }

  if (activeFactory && missingCredential) {
    return (
      <section className={draftStartClass} aria-label={t('newPage.credentialRequired')}>
        <MissingCredentialState factoryId={activeFactory.id} guard={missingCredential} />
      </section>
    );
  }

  return (
    <section className={draftStartClass} aria-labelledby="draft-start-heading">
      <Txt as="h1" variant="title" tone="ink" id="draft-start-heading" className="m-0 text-center">
        {t('newPage.heading')}
      </Txt>
      {configurationError && (
        <Notice variant="destructive">
          {t('newPage.configError', { message: configurationError.message })}
        </Notice>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        {activeFactory && <ComposerPanel composerVariant="textarea" />}
        <FactoryContext activeFactory={activeFactory} />
        {claudeCode && (
          <Txt as="p" variant="caption" tone="muted" className="m-0">
            {t('newPage.claudeCode.note')}
          </Txt>
        )}
      </div>
    </section>
  );
}

type ClaudeCodeBlocker = 'harnessUnavailable' | 'noRepository';

/**
 * What keeps a Claude Code chat from starting, said before anyone types: the
 * server has no Claude Code harness, or the Factory has no repository for the
 * session to check out (Claude Code runs in a checkout of it).
 */
function claudeCodeBlocker(
  factory: FactoryProject,
  claudeCodeAvailable: boolean | undefined,
): ClaudeCodeBlocker | undefined {
  if (claudeCodeAvailable === false) return 'harnessUnavailable';
  if (factory.repositories.length === 0) return 'noRepository';
  return undefined;
}

function ClaudeCodeBlockedState({ factoryId, blocker }: { factoryId: string; blocker: ClaudeCodeBlocker }) {
  const { t } = useTranslation('chat');
  const target = settingsSectionPath(factoryId, blocker === 'noRepository' ? 'repositories' : 'models');
  return (
    <EmptyState
      as="h2"
      iconSlot={<Bot />}
      titleSlot={t(`newPage.claudeCode.${blocker}.title`)}
      descriptionSlot={t(`newPage.claudeCode.${blocker}.description`)}
      actionSlot={
        <Link to={target} className={buttonVariants({ variant: 'primary' })}>
          {t(`newPage.claudeCode.${blocker}.action`)}
        </Link>
      }
    />
  );
}

function MissingCredentialState({ factoryId, guard }: { factoryId: string; guard: MissingCredentialGuard }) {
  const { t } = useTranslation('chat');
  const authQuery = useFactoryAuth();
  const providerName = providerDisplayName(guard.provider);
  const descriptionValues = { modelId: guard.modelId, provider: providerName };
  return (
    <EmptyState
      as="h2"
      iconSlot={<Bot />}
      titleSlot={t('newPage.noAccessTitle', { provider: providerName })}
      descriptionSlot={
        authQuery.data?.authEnabled === true
          ? t('newPage.noAccessDescriptionOrg', descriptionValues)
          : t('newPage.noAccessDescription', descriptionValues)
      }
      actionSlot={
        <Link to={settingsSectionPath(factoryId, 'models', MODEL_DEFAULTS_ANCHORS.factory)} className={buttonVariants({ variant: 'primary' })}>
          {t('newPage.openModelsSettings')}
        </Link>
      }
    />
  );
}

function MissingModelState({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('chat');
  return (
    <EmptyState
      as="h2"
      iconSlot={<Bot />}
      titleSlot={t('newPage.noModelTitle')}
      descriptionSlot={t('newPage.noModelDescription')}
      actionSlot={
        <Link to={settingsSectionPath(factoryId, 'models', MODEL_DEFAULTS_ANCHORS.factory)} className={buttonVariants({ variant: 'primary' })}>
          {t('newPage.openModelsSettings')}
        </Link>
      }
    />
  );
}

function FactoryContext({ activeFactory }: { activeFactory: FactoryProject | undefined }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const sessionQuery = useUserSessionQuery(sessionId);
  const repository = activeFactory?.repositories.find(
    repo => repo.projectRepositoryId === sessionQuery.data?.projectRepositoryId,
  );
  const projectPath = sessionQuery.data?.sessionId;
  const gitBranch = repository?.gitBranch;
  return (
    <div className="text-muted-foreground flex max-w-full items-center gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <FolderIcon size={13} className="text-placeholder shrink-0" />
        <Txt as="span" variant="column" title={activeFactory?.name} className="min-w-0 truncate">
          {activeFactory?.name ?? 'Factory'}
        </Txt>
        {projectPath && (
          <>
            <Txt as="span" variant="caption" tone="faint" className="shrink-0">
              ·
            </Txt>
            <Txt as="span" variant="caption" tone="faint" title={projectPath} className="min-w-0 truncate">
              {projectPath}
            </Txt>
          </>
        )}
      </div>
      {gitBranch && (
        <>
          <Txt as="span" variant="caption" tone="faint" aria-hidden className="shrink-0">
            ·
          </Txt>
          <div className="flex min-w-0 items-center gap-1.5">
            <GitBranch size={13} aria-hidden className="text-placeholder shrink-0" />
            <Txt as="span" variant="caption" title={gitBranch} className="min-w-0 truncate">
              {gitBranch}
            </Txt>
          </div>
        </>
      )}
    </div>
  );
}
