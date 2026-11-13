import {
  AnnotationMarkers,
  AnnotationSelectionToolbar,
  useOptionalChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import { Button } from '@mastra/playground-ui/components/Button';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { passageLines, passageLink } from '../../passage-lines';

/**
 * Notes on a document, as the chat takes notes on a message: select a passage, write a note. Each passage
 * is quoted under a link to the file and the lines it came from (`path:262-275`), so the agent goes
 * straight to them and the person can open the file from the sent message. They all go to the session
 * with the next message. Only inside a chat; a viewer without one shows the file as before.
 */
export function FileAnnotations({
  containerRef,
  filePath,
  source,
}: {
  containerRef: RefObject<HTMLElement | null>;
  filePath: string;
  /** The file's markdown, which the passage's lines are counted in. */
  source: string;
}) {
  const chat = useOptionalChatAnnotations();
  if (!chat) return null;
  const { annotations, addAnnotation, removeAnnotation, setAnnotationComment } = chat;
  const container = containerRef.current;
  const own = annotations.filter(annotation => container?.contains(annotation.source.element));
  return (
    <>
      <AnnotationMarkers
        containerRef={containerRef}
        annotations={own}
        onRemove={removeAnnotation}
        onCommentChange={setAnnotationComment}
      />
      <AnnotationSelectionToolbar
        containerRef={containerRef}
        onAnnotate={annotation => {
          const lines = passageLines(source, annotation.text, annotation.source.textBefore);
          addAnnotation({ ...annotation, text: `${passageLink(filePath, lines)}\n${annotation.text}` });
        }}
      />
    </>
  );
}

/**
 * "Send all (N)" in the full-screen document: the chat composer is behind the dialog, so the notes made
 * here are sent from here, through the composer's own send, and the dialog closes.
 */
export function SendNotesButton({ onSent }: { onSent: () => void }) {
  const { t } = useTranslation('workspaces');
  const chat = useOptionalChatAnnotations();
  if (!chat) return null;
  const count = chat.annotations.length;
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      disabled={count === 0}
      onClick={() => {
        chat.requestSend();
        onSent();
      }}
    >
      {t('fileViewer.sendNotes', { count })}
    </Button>
  );
}
