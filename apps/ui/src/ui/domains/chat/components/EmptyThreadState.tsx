import { Button } from '@mastra/playground-ui/components/Button';
import { DisclosureChevron } from '@mastra/playground-ui/components/DisclosureChevron';
import { Logo } from '@mastra/playground-ui/components/Logo';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { textStyle } from '@mastra/playground-ui/primitives/text';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Trans, useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useChatCommands } from '../context/ChatCommandsProvider';
import { useChatSessionContext } from '../context/useChatSessionContext';
import { Txt } from '@mastra/playground-ui/components/Txt';

const emptyThreadClass =
  'flex w-full min-w-0 max-w-full flex-1 flex-col items-center justify-center px-6 py-12 text-center';

function FactoryMetadata({ label, value, font = 'mono' }: { label: string; value: string; font?: 'body' | 'mono' }) {
  return (
    <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <dt className={textStyle({ variant: 'caption', tone: 'muted' })}>{label}</dt>
      <dd className={cn(textStyle({ variant: 'caption', tone: 'ink', font }), 'min-w-0 truncate')}>{value}</dd>
    </div>
  );
}

export function EmptyThreadState() {
  const { t } = useTranslation('chat');
  const { factoryId } = useParams<{ factoryId: string }>();
  const { data: activeFactory } = useFactoryQuery(factoryId);
  const { sessionId, resourceId, factorySessionState } = useChatSessionContext();
  const { prefillComposer } = useChatCommands();
  if (!activeFactory) return null;

  const repository = activeFactory.repositories.find(
    repo => repo.projectRepositoryId === factorySessionState?.projectRepositoryId,
  );
  const gitBranch = repository?.gitBranch;

  return (
    <section className={emptyThreadClass} aria-labelledby="empty-thread-title">
      <Logo size="md" aria-label="Mastra Code" />
      <Txt as="h1" variant="display" tone="ink" id="empty-thread-title" className="mt-7 text-balance">
        {t('emptyThread.title')}
      </Txt>
      <Txt variant="body-sm" tone="muted" className="mt-2 max-w-lg text-pretty">
        {t('emptyThread.subtitle')}
      </Txt>

      <div
        className="mt-7 flex w-full max-w-2xl flex-wrap justify-center gap-2"
        aria-label={t('emptyThread.suggestedPrompts')}
      >
        <Button type="button" size="md" onClick={() => prefillComposer(t('emptyThread.explorePrompt'))}>
          {t('emptyThread.explore')}
        </Button>
        <Button type="button" size="md" onClick={() => prefillComposer(t('emptyThread.planPrompt'))}>
          {t('emptyThread.plan')}
        </Button>
        <Button type="button" size="md" onClick={() => prefillComposer(t('emptyThread.reviewPrompt'))}>
          {t('emptyThread.review')}
        </Button>
        <Button type="button" size="md" onClick={() => prefillComposer(t('emptyThread.debugPrompt'))}>
          {t('emptyThread.debug')}
        </Button>
      </div>

      <details className="text-muted-foreground group mt-8 w-full max-w-lg min-w-0">
        <summary
          className={`hover:text-foreground flex cursor-pointer list-none items-center justify-center gap-1.5 rounded-full px-3 py-2 transition-colors [&::-webkit-details-marker]:hidden ${focusRing}`}
        >
          <Txt as="span" variant="caption">
            <Trans
              t={t}
              i18nKey="emptyThread.workingIn"
              values={{ name: activeFactory.name }}
              components={{ name: <Txt as="span" variant="column" tone="ink" /> }}
            />
          </Txt>
          <DisclosureChevron className="size-3.5 group-open:rotate-180" />
        </summary>
        <dl className="mx-auto mt-3 grid w-full min-w-0 gap-1 text-left">
          <FactoryMetadata label="Factory" value={activeFactory.name} font="body" />
          {resourceId && <FactoryMetadata label={t('emptyThread.resourceId')} value={resourceId} />}
          {gitBranch && <FactoryMetadata label={t('emptyThread.branch')} value={gitBranch} />}
          {sessionId && sessionId !== resourceId && (
            <FactoryMetadata label={t('emptyThread.sessionId')} value={sessionId} />
          )}
        </dl>
      </details>
    </section>
  );
}
