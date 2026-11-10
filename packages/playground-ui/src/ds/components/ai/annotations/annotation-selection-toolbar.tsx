import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { CornerDownLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

import type { NewChatAnnotation } from './chat-annotations';
import { useAnnotationSelection } from './use-annotation-selection';
import { Button } from '@/ds/components/Button';
import { Textarea } from '@/ds/components/Textarea';
import { Txt } from '@/ds/components/Txt';
import { FLOATING_POSITION_METHOD } from '@/ds/primitives/floating';
import { usePortalContainer } from '@/ds/primitives/portal-container';
import { overlaySurfaceStyle } from '@/ds/primitives/raised-surface';
import { cn } from '@/lib/utils';
import { libText } from '@/lib/lib-text';

export interface AnnotationSelectionToolbarProps {
  containerRef: RefObject<HTMLElement | null>;
  onAnnotate: (annotation: NewChatAnnotation) => void;
}

const hasModifier = (event: KeyboardEvent | ReactKeyboardEvent) => event.altKey || event.ctrlKey || event.metaKey;

/**
 * Over a selected passage: a note field and "Add note". The note field takes focus only when the person
 * clicks or tabs into it, so a plain selection can still be copied; from then the passage is pinned, so
 * the collapsed page selection does not close the card. An empty note adds the passage as a quote only.
 */
export function AnnotationSelectionToolbar({ containerRef, onAnnotate }: AnnotationSelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const { open, selection, dismiss, pin } = useAnnotationSelection(containerRef, toolbarRef);
  const portalContainer = usePortalContainer();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const actionsRef = useRef<PopoverPrimitive.Root.Actions>(null);
  const originRef = useRef<HTMLElement>(undefined);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    // Focus sits on the scroller around the transcript, outside anything this component renders.
    const onKeyDown = (event: KeyboardEvent) => {
      const field = noteRef.current;
      const transcript = containerRef.current;
      const { target } = event;
      if (!field || !transcript || hasModifier(event)) return;
      const holdsTranscript = target instanceof HTMLElement && target !== document.body && target.contains(transcript);
      if (event.key !== 'Tab' || event.shiftKey || !holdsTranscript) return;
      pin();
      field.focus();
      if (document.activeElement !== field) {
        actionsRef.current?.close();
        return;
      }
      event.preventDefault();
      originRef.current = target;
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      originRef.current = undefined;
    };
  }, [open, containerRef, pin]);

  const close = () => {
    setNote('');
    dismiss();
  };

  const cancel = () => {
    // Cleared too: otherwise the press that cancels settles on the same selection and reopens the card.
    document.getSelection()?.removeAllRanges();
    close();
    originRef.current?.focus();
  };

  const addNote = () => {
    if (!selection) return;
    // Cleared first: the consumer usually focuses its composer next, and that must keep its caret.
    document.getSelection()?.removeAllRanges();
    const comment = note.trim();
    close();
    onAnnotate({ text: selection.text, source: selection.source, ...(comment ? { comment } : {}) });
  };

  return (
    <PopoverPrimitive.Root
      actionsRef={actionsRef}
      open={open}
      onOpenChange={next => {
        if (!next) close();
      }}
    >
      <PopoverPrimitive.Portal container={portalContainer}>
        <PopoverPrimitive.Positioner
          anchor={selection?.anchor}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          positionMethod={FLOATING_POSITION_METHOD}
          className="z-50 outline-none data-[anchor-hidden]:invisible"
        >
          <PopoverPrimitive.Popup
            ref={toolbarRef}
            role="dialog"
            aria-label={libText('Note on the selected text')}
            initialFocus={false}
            finalFocus={false}
            // A press on the card pins the passage before focus moves and the page selection collapses.
            onPointerDown={pin}
            // A press on a button must not collapse the selection it acts on; the note field takes focus normally.
            onMouseDown={event => {
              if (!(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
            }}
            data-slot="annotation-selection-toolbar"
            className={cn(
              'flex w-80 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col gap-2.5 rounded-lg p-3 focus-visible:outline-hidden',
              overlaySurfaceStyle,
              'motion-safe:data-[closed]:animate-out motion-safe:data-[closed]:fade-out-0 motion-safe:data-[closed]:zoom-out-95',
              'motion-safe:data-[open]:animate-in motion-safe:data-[open]:fade-in-0 motion-safe:data-[open]:zoom-in-95',
            )}
          >
            {/* The passage the note is about, as the annotation card shows it. */}
            <blockquote className="line-clamp-3 border-l-2 border-info-indicator ps-2.5 text-body-sm whitespace-pre-line text-muted-foreground">
              {selection?.text}
            </blockquote>
            <Textarea
              ref={noteRef}
              aria-label={libText('Note for the agent')}
              placeholder={libText('Note for the agent')}
              rows={2}
              className="min-h-14 resize-none"
              value={note}
              onFocus={pin}
              onChange={event => setNote(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addNote();
                }
              }}
            />
            <div className="flex items-center justify-end gap-1">
              <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={cancel}>
                {libText('Cancel')}
              </Button>
              <Button type="button" size="sm" className="shrink-0" icon={<CornerDownLeft />} onClick={addNote}>
                {libText('Add note')}
              </Button>
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
