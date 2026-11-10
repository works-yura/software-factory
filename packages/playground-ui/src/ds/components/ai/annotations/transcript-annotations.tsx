import { AnnotationMarkers } from './annotation-markers';
import { AnnotationSelectionToolbar } from './annotation-selection-toolbar';
import { useChatAnnotations } from './chat-annotations';
import { useChatShellRegions } from '@/ds/components/ChatShell/chat-shell-context';

/**
 * Everything annotations add to a transcript, wired to `ChatAnnotationsProvider`: Add to chat over
 * selected text, and the numbered comment bubbles of what was added. Render it inside
 * `ChatShell.Transcript`; adding an annotation focuses the `ComposerInput` in `ChatShell.Dock`.
 */
export function TranscriptAnnotations() {
  const { transcriptRef, composerInputRef } = useChatShellRegions();
  const { annotations, addAnnotation, removeAnnotation, setAnnotationComment } = useChatAnnotations();

  return (
    <>
      <AnnotationMarkers
        containerRef={transcriptRef}
        // Passages from another surface (a document beside the chat) show their markers there.
        annotations={annotations.filter(annotation => transcriptRef.current?.contains(annotation.source.element) ?? true)}
        onRemove={removeAnnotation}
        onCommentChange={setAnnotationComment}
      />
      <AnnotationSelectionToolbar
        containerRef={transcriptRef}
        onAnnotate={annotation => {
          addAnnotation(annotation);
          composerInputRef.current?.focus();
        }}
      />
    </>
  );
}
