import { Trash2 } from 'lucide-react';
import type { Ref } from 'react';

import { AnnotationNumber } from './annotation-number';
import type { ChatAnnotation } from './chat-annotations';
import { Button } from '@/ds/components/Button';
import { Textarea } from '@/ds/components/Textarea';
import { Txt } from '@/ds/components/Txt';
import { libText } from '@/lib/lib-text';

export interface AnnotationCommentCardProps {
  annotation: ChatAnnotation;
  number: number;
  commentRef?: Ref<HTMLTextAreaElement>;
  onCommentChange: (comment: string) => void;
  onRemove: () => void;
  onDone: () => void;
}

export function AnnotationCommentCard({
  annotation,
  number,
  commentRef,
  onCommentChange,
  onRemove,
  onDone,
}: AnnotationCommentCardProps) {
  return (
    <div data-slot="annotation-comment-card" className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <AnnotationNumber>{number}</AnnotationNumber>
        <Txt as="span" variant="label" className="flex-1">
          Annotation {number}
        </Txt>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-my-1 -me-1"
          tooltip={libText('Remove annotation {number}').replace('{number}', String(number))}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <blockquote className="line-clamp-3 border-l-2 border-info-indicator ps-2.5 text-body-sm whitespace-pre-line text-muted-foreground">
        {annotation.text}
      </blockquote>
      <Textarea
        ref={commentRef}
        aria-label={libText('Comment on annotation {number}').replace('{number}', String(number))}
        placeholder={libText('Add a comment')}
        rows={3}
        className="min-h-18 resize-none"
        value={annotation.comment ?? ''}
        onChange={event => onCommentChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onDone();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {libText('Sent with your next message')}
        </Txt>
        <Button type="button" size="sm" onClick={onDone}>
          {libText('Done')}
        </Button>
      </div>
    </div>
  );
}
