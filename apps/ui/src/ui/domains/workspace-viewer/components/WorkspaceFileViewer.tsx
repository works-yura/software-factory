import {
  AnnotationMarkers,
  AnnotationSelectionToolbar,
  useOptionalChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import { Button } from '@mastra/playground-ui/components/Button';
import { Code } from '@mastra/playground-ui/components/Code';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import type { RefObject } from 'react';

import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../i18n';
import { translator } from '../../../i18n/t';
import type { WorkspaceFilePreview } from './workspace-file-preview';

const tk = translator('workspaces');

/**
 * Comments on a document, as the chat takes comments on a message: select a passage, Add to chat, write
 * a note. Each passage is quoted with the file's path, and they all go to the session with the next
 * message. Only inside a chat; a viewer without one shows the file as before.
 */
function FileAnnotations({ containerRef, filePath }: { containerRef: RefObject<HTMLElement | null>; filePath: string }) {
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
        onAnnotate={annotation => addAnnotation({ ...annotation, text: `\`${filePath}\`\n${annotation.text}` })}
      />
    </>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return tk('fileViewer.bytes', { size });
  if (size < 1024 * 1024) return tk('fileViewer.kilobytes', { size: Math.round(size / 1024) });
  return tk('fileViewer.megabytes', { size: (size / (1024 * 1024)).toFixed(1) });
}

interface WorkspaceFileViewerProps {
  filePath: string;
  file?: WorkspaceFilePreview;
  isLoading: boolean;
  isRefreshing: boolean;
  error?: Error;
  onRefresh: () => void;
  onBack: () => void;
}

export function WorkspaceFileViewer({
  filePath,
  file,
  isLoading,
  isRefreshing,
  error,
  onRefresh,
  onBack,
}: WorkspaceFileViewerProps) {
  const { t } = useTranslation('workspaces');
  const content = file?.content ?? '';
  const isMarkdown = file?.language === 'markdown';
  const documentRef = useRef<HTMLDivElement>(null);

  return (
    <section className="flex min-h-0 min-w-0 grow flex-col" aria-label={t('fileViewer.label')}>
      <div className="border-border flex shrink-0 items-center gap-2 border-b p-1.5">
        <Button
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          onClick={onBack}
          aria-label={t('fileViewer.back')}
        >
          <ArrowLeft />
        </Button>
        <Txt tone="ink" variant="column" className="min-w-0 flex-1 truncate">
          {file?.name ?? filePath}
        </Txt>
        <div className="flex shrink-0 items-center gap-1">
          {file?.contentType === 'text' ? (
            <CopyButton content={content} size="icon-sm" variant="ghost" tooltip={t('fileViewer.copy')} />
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={isRefreshing ? t('fileViewer.refreshing') : t('fileViewer.refresh')}
          >
            {isRefreshing ? <Spinner size="sm" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      {file ? (
        <div className="border-border flex shrink-0 items-center gap-3 border-b px-3 py-2">
          <Txt tone="muted" as="span" variant="caption" className="min-w-0 truncate">
            {file.path}
          </Txt>
          <Txt tone="muted" as="span" variant="caption" className="ml-auto shrink-0">
            {formatBytes(file.size)}
          </Txt>
          <Txt tone="muted" as="span" variant="caption" className="shrink-0">
            {new Date(file.updatedAt).toLocaleString(currentLanguage())}
          </Txt>
          {file.truncated ? (
            <Txt tone="muted" as="span" variant="caption" className="shrink-0">
              {t('fileViewer.truncated')}
            </Txt>
          ) : null}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner size="sm" />
        </div>
      ) : null}
      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
          <Txt variant="caption" className="text-destructive-foreground">
            {error.message}
          </Txt>
        </div>
      ) : null}
      {!isLoading && !error ? (
        <ScrollArea className="min-h-0 flex-1" orientation="both">
          <div className="p-3">
            {file?.contentType === 'unsupported' ? (
              <Txt tone="muted">{t('fileViewer.unsupported')}</Txt>
            ) : null}
            {file?.contentType === 'text' && isMarkdown ? (
              <div ref={documentRef} className="relative">
                {/* The slot annotations select from, as a chat message marks its content. */}
                <div data-slot="message-content">
                  <MarkdownRenderer>{content}</MarkdownRenderer>
                </div>
                <FileAnnotations containerRef={documentRef} filePath={filePath} />
              </div>
            ) : null}
            {file?.contentType === 'text' && !isMarkdown ? (
              <Code
                code={content}
                lang={file.language}
                className="border-border bg-background text-caption text-foreground m-0 rounded-md border p-3 font-mono"
              />
            ) : null}
          </div>
        </ScrollArea>
      ) : null}
    </section>
  );
}
