import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { TokenBudget, TokenBudgetDetail } from '@mastra/playground-ui/components/TokenBudget';
import { Brain, MessageSquare } from 'lucide-react';
import { useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { lazyLabels } from '../../../../i18n/lazy';
import { formatTokens } from '../../../usage/format';
import { translator } from '../../../../i18n/t';

import { ChatSessionContext } from '../../context/ChatSessionContext';
import { useChatRuntime } from '../../context/useChatRuntime';
import type { OMWork } from '../../services/om';
import { omWork } from '../../services/om';

const tk = translator('chat');

const OM_WORK: readonly OMWork[] = ['idle', 'background', 'blocking'];
const messageLabel = lazyLabels(OM_WORK, work => `chat:memory.messages.${work}`);
const observationLabel = lazyLabels(OM_WORK, work => `chat:memory.observations.${work}`);

function reading(tokens: number, threshold: number) {
  return tk('memory.reading', { tokens: formatTokens(tokens), threshold: formatTokens(threshold) });
}

export function OperationalMemoryStatus() {
  const { t } = useTranslation('chat');
  const runtime = useChatRuntime();
  // A harness without observational memory (Claude Code) has no budgets to show, whatever the runtime reports.
  const memorySupported = useContext(ChatSessionContext)?.harness?.supports.memory !== false;
  const om = memorySupported ? runtime.omProgress : undefined;
  const work = omWork(runtime);
  const showMsg = om && om.threshold > 0;
  const showMem = om && om.reflectionThreshold > 0 && om.observationTokens > 0;

  if (!showMsg && !showMem) return null;

  const messageTone = work.messages === 'blocking' ? 'warning' : 'messages';
  const observationTone = work.observations === 'blocking' ? 'warning' : 'memory';
  // Buttons hide descendant semantics, so the trigger names both budgets.
  const spoken = [
    showMsg && `${messageLabel[work.messages]}, ${reading(om.pendingTokens, om.threshold)}`,
    showMem && `${observationLabel[work.observations]}, ${reading(om.observationTokens, om.reflectionThreshold)}`,
  ].filter(Boolean);

  const label = t('memory.budgets', { budgets: spoken.join('. ') });

  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="sm" aria-label={label} tooltip={label} className="gap-3">
        {showMsg && (
          <TokenBudget
            label={messageLabel[work.messages]}
            threshold={om.threshold}
            tokens={om.pendingTokens}
            tone={messageTone}
            working={work.messages !== 'idle'}
            format={formatTokens}
          />
        )}
        {showMem && (
          <TokenBudget
            label={observationLabel[work.observations]}
            threshold={om.reflectionThreshold}
            tokens={om.observationTokens}
            tone={observationTone}
            working={work.observations !== 'idle'}
            format={formatTokens}
          />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex flex-col gap-3.5" side="top">
        {showMsg && (
          <TokenBudgetDetail
            description={t('memory.messagesDescription')}
            icon={<MessageSquare />}
            label={t('memory.messagesLabel')}
            threshold={om.threshold}
            tokens={om.pendingTokens}
            tone={messageTone}
            format={formatTokens}
          />
        )}
        {showMem && (
          <TokenBudgetDetail
            description={t('memory.observationsDescription')}
            icon={<Brain />}
            label={t('memory.observationsLabel')}
            threshold={om.reflectionThreshold}
            tokens={om.observationTokens}
            tone={observationTone}
            format={formatTokens}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
