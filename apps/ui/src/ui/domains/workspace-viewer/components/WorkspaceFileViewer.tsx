import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, Download, Maximize2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { downloadText } from '../../../../lib/downloadText';
import { currentLanguage } from '../../../i18n';
import { translator } from '../../../i18n/t';
import { ExpandedFileDialog } from './file-viewer/ExpandedFileDialog';
import { FileDocument } from './file-viewer/FileDocument';
import { MediaDocument, mediaBlob } from './file-viewer/MediaDocument';
import type { WorkspaceFilePreview } from './workspace-file-preview';

const tk = translator('workspaces');

/** The whole file as a download: for what the viewer cannot show (a build, an archive) or shows only in part. */
export function workspaceFileDownloadUrl(baseUrl: string, file: Pick<WorkspaceFilePreview, 'workspacePath' | 'path'>) {
  return `${baseUrl}/web/workspace/file/download?${new URLSearchParams({ workspacePath: file.workspacePath, path: file.path })}`;
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
  const [expanded, setExpanded] = useState(false);
  const isText = file?.contentType === 'text';
  const isMedia = file?.contentType === 'media';
  const { baseUrl } = useApiConfig();
  // Text shown whole and media are saved from what the page holds; anything else comes from the server.
  const fromServer = Boolean(file && (file.contentType === 'unsupported' || file.truncated));

  const downloadMedia = () => {
    const blob = file && mediaBlob(file);
    if (!blob || !file) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

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
          {fromServer && file ? (
            <Button
              size="icon-sm"
              variant="ghost"
              render={<a href={workspaceFileDownloadUrl(baseUrl, file)} download={file.name} />}
              aria-label={t('fileViewer.download')}
            >
              <Download />
            </Button>
          ) : null}
          {isText && file && !fromServer ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() =>
                downloadText(
                  file.name ?? filePath.split('/').pop() ?? 'file.txt',
                  content,
                  isMarkdown ? 'text/markdown' : 'text/plain',
                )
              }
              aria-label={t('fileViewer.download')}
            >
              <Download />
            </Button>
          ) : null}
          {isMedia ? (
            <Button size="icon-sm" variant="ghost" onClick={downloadMedia} aria-label={t('fileViewer.download')}>
              <Download />
            </Button>
          ) : null}
          {isText ? (
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
              <div className="flex flex-col items-start gap-2">
                <Txt tone="muted">{t('fileViewer.unsupported')}</Txt>
                <Button size="sm" variant="default" render={<a href={workspaceFileDownloadUrl(baseUrl, file)} download={file.name} />}>
                  <Download />
                  {t('fileViewer.download')}
                </Button>
              </div>
            ) : null}
            {isText && file && !expanded ? <FileDocument file={file} filePath={filePath} /> : null}
            {isMedia && file ? <MediaDocument file={file} /> : null}
          </div>
        </ScrollArea>
      ) : null}
      {expanded && isText && file ? (
        <ExpandedFileDialog file={file} filePath={filePath} onClose={() => setExpanded(false)} />
      ) : null}
    </section>
  );
}
