import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { MessageSquare, SquareKanban, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FactoryRef } from '../services/factoryRefs';

function RefIcon({ target }: { target: FactoryRef }) {
  return target.kind === 'card' ? <SquareKanban aria-hidden /> : <MessageSquare aria-hidden />;
}

/** The references waiting in the composer, each removable. */
export function ComposerFactoryRefs({
  refs,
  onRemove,
}: {
  refs: readonly FactoryRef[];
  onRemove: (ref: FactoryRef) => void;
}) {
  const { t } = useTranslation('chat');
  if (refs.length === 0) return null;
  return (
    <ul aria-label={t('refs.attached')} data-slot="composer-factory-refs" className="flex flex-wrap gap-1 px-2 pt-2">
      {refs.map(ref => (
        <li key={`${ref.sessionId}:${ref.workItemId ?? ''}`} className="flex items-center gap-0.5">
          <Badge size="md" variant="neutral" icon={<RefIcon target={ref} />} title={ref.board ? `${ref.board} · ${ref.title}` : ref.title}>
            <span className="max-w-48 truncate">{ref.title}</span>
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('refs.remove', { title: ref.title })}
            onClick={() => onRemove(ref)}
          >
            <X />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The references a sent message carried, as the transcript shows them. */
export function MessageFactoryRefs({ refs }: { refs: readonly FactoryRef[] }) {
  const { t } = useTranslation('chat');
  if (refs.length === 0) return null;
  return (
    <ul aria-label={t('refs.sent')} data-slot="message-factory-refs" className="mt-2 flex flex-wrap gap-1">
      {refs.map(ref => (
        <li key={`${ref.sessionId}:${ref.workItemId ?? ''}`}>
          <Badge size="md" variant="neutral" icon={<RefIcon target={ref} />} title={ref.board ? `${ref.board} · ${ref.title}` : ref.title}>
            <span className="max-w-48 truncate">{ref.title}</span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}
