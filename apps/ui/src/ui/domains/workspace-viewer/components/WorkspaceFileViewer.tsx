import {
  AnnotationMarkers,
  AnnotationSelectionToolbar,
  useOptionalChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import { Button } from '@mastra/playground-ui/components/Button';
import { Code } from '@mastra/playground-ui/components/Code';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, Download, Maximize2, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';

import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../i18n';
import { translator } from '../../../i18n/t';
import type { WorkspaceFilePreview } from './workspace-file-preview';

const tk = translator('workspaces');

/** Saves the shown text file under its own name, as the person sees it (no round trip to the server). */
function downloadTextFile(name: string, content: string, language?: string) {
  const type = language === 'markdown' ? 'text/markdown' : 'text/plain';
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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
  const expandedRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const canExpand = file?.contentType === 'text';

  /** The markdown document, annotatable; long lines wrap instead of running off the panel. */
  const markdownDocument = (ref: typeof documentRef) => (
    <div ref={ref} className="relative min-w-0 wrap-anywhere [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
      {/* The slot annotations select from, as a chat message marks its content. */}
      <div data-slot="message-content">
        <MarkdownRenderer>{content}</MarkdownRenderer>
      </div>
      <FileAnnotations containerRef={ref} filePath={filePath} />
    </div>
  );

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
          {canExpand && file ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => downloadTextFile(file.name ?? filePath.split('/').pop() ?? 'file.txt', content, file.language)}
              aria-label={t('fileViewer.download')}
            >
              <Download />
            </Button>
          ) : null}
          {canExpand ? (
            <Button size="icon-sm" variant="ghost" onClick={() => setExpanded(true)} aria-label={t('fileViewer.expand')}>
              <Maximize2 />
            </Button>
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
        <ScrollArea className="min-h-0 flex-1" orientation={isMarkdown ? 'vertical' : 'both'}>
          <div className="p-3">
            {file?.contentType === 'unsupported' ? (
              <Txt tone="muted">{t('fileViewer.unsupported')}</Txt>
            ) : null}
            {file?.contentType === 'text' && isMarkdown && !expanded ? markdownDocument(documentRef) : null}
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
      {expanded && file?.contentType === 'text' ? (
        <Dialog open onOpenChange={open => !open && setExpanded(false)}>
          <DialogContent size="full" aria-label={file.name ?? filePath}>
            <DialogHeader>
              <DialogTitle>{file.name ?? filePath}</DialogTitle>
              <Txt tone="muted" as="span" variant="caption" className="truncate">
                {file.path}
              </Txt>
            </DialogHeader>
            <DialogBody>
              <div className="mx-auto w-full max-w-[52rem]">
                {isMarkdown ? (
                  markdownDocument(expandedRef)
                ) : (
                  <Code
                    code={content}
                    lang={file.language}
                    className="border-border bg-background text-caption text-foreground m-0 rounded-md border p-3 font-mono"
                  />
                )}
              </div>
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
