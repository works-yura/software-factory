import { agentGlyph } from '@mastra/playground-ui/components/AgentIndicator';
import { Shimmer } from '@mastra/playground-ui/components/Shimmer';
import { Brain } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { translator } from '../../../../i18n/t';

import { useChatRuntime } from '../../context/useChatRuntime';
import type { OMWorkByBudget } from '../../services/om';
import { omWork } from '../../services/om';

const tk = translator('chat');
const MemoryGlyph = agentGlyph('memory');

const statusItem = 'inline-flex items-center gap-1 text-muted-foreground [&_svg]:text-placeholder';

function holdingLabel({ messages, observations }: OMWorkByBudget): string | undefined {
  if (messages === 'blocking') return tk('status.savingMemory');
  if (observations === 'blocking') return tk('status.consolidatingMemory');
  return undefined;
}

export function RuntimeActivity() {
  const { t } = useTranslation('chat');
  const runtime = useChatRuntime();
  const label = holdingLabel(omWork(runtime));

  return (
    <>
      {label && (
        <span className={statusItem}>
          <MemoryGlyph size={13} /> <Shimmer>{label}</Shimmer>
        </span>
      )}
      {runtime.tokensPerSec > 0 && <span className={statusItem}>{t('status.tokensPerSecond', { rate: runtime.tokensPerSec })}</span>}
    </>
  );
}
