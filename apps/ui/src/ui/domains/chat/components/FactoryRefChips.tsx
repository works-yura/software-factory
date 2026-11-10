import { AttachmentCard } from '@mastra/playground-ui/components/AttachmentCard';
import { ComposerAttachment } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment';
import { ComposerAttachmentEntry } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-entry';
import { ComposerAttachmentList } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-list';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { refKey } from '../services/factoryRefs';
import type { FactoryRef } from '../services/factoryRefs';
import { refKind } from '../services/refKinds';

/**
 * How a reference shows, read from its kind's descriptor. A kind this app does not know (sent by a newer
 * client) still shows by its title and kind name, and opens nothing.
 */
function useRefView() {
  const { factoryId } = useParams();
  return (ref: FactoryRef) => {
    const kind = refKind(ref.kind);
    const Icon = kind?.icon ?? Link2;
    return {
      icon: <Icon size={16} aria-hidden />,
      subtitle: kind ? kind.subtitle(ref) : ref.kind,
      href: kind?.href && factoryId ? kind.href(ref, { factoryId }) : undefined,
    };
  };
}

/** The references waiting in the composer, laid out and removed like the files beside them. */
export function ComposerFactoryRefs({
  refs,
  onRemove,
}: {
  refs: readonly FactoryRef[];
  onRemove: (ref: FactoryRef) => void;
}) {
  const { t } = useTranslation('chat');
  const view = useRefView();
  if (refs.length === 0) return null;
  return (
    <ComposerAttachmentList aria-label={t('refs.attached')} data-slot="composer-factory-refs">
      {refs.map(ref => {
        const { icon, subtitle } = view(ref);
        return (
          <ComposerAttachment
            key={refKey(ref)}
            name={ref.title}
            variant="inline"
            removeLabel={t('refs.remove', { title: ref.title })}
            onRemove={() => onRemove(ref)}
          >
            <ComposerAttachmentEntry description={subtitle}>{icon}</ComposerAttachmentEntry>
          </ComposerAttachment>
        );
      })}
    </ComposerAttachmentList>
  );
}

/** The references a sent message carried, shown like its sent files; each opens where its kind says. */
export function MessageFactoryRefs({ refs }: { refs: readonly FactoryRef[] }) {
  const { t } = useTranslation('chat');
  const view = useRefView();
  const navigate = useNavigate();
  if (refs.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t('refs.sent')}
      data-slot="message-factory-refs"
      className="flex max-w-full min-w-0 flex-wrap justify-end gap-2"
    >
      {refs.map(ref => {
        const { icon, subtitle, href } = view(ref);
        return (
          <AttachmentCard
            key={refKey(ref)}
            name={ref.title}
            typeLabel={subtitle}
            icon={icon}
            {...(href ? { onClick: () => void navigate(href), actionLabel: t('refs.open', { title: ref.title }) } : {})}
          />
        );
      })}
    </div>
  );
}
