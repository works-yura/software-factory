import { Button } from '@mastra/playground-ui/components/Button';
import type { MarkdownRendererProps } from '@mastra/playground-ui/components/MarkdownRenderer';
import { FileText } from 'lucide-react';
import { useContext, useMemo } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { WorkspacePanelContext } from '../../workspace-viewer/context/WorkspacePanelContext';
import { linkedProductDocuments, workspaceFilePath } from '../../workspace-viewer/workspace-file-link';
import type { ProductDocument } from '../../workspace-viewer/workspace-file-link';

type MarkdownComponents = NonNullable<MarkdownRendererProps['components']>;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Markdown overrides for a session chat: a link to a file in the session's workspace opens it in the
 * Files panel instead of navigating; every other link behaves as the renderer draws it. Undefined
 * outside a session with a Files panel, so the renderer keeps its own links there.
 */
export function useWorkspaceFileLinkComponents(): MarkdownComponents | undefined {
  const openFile = useContext(WorkspacePanelContext)?.openFile;
  const { t } = useTranslation('chat');
  return useMemo(() => {
    if (!openFile) return undefined;
    return {
      a: function WorkspaceAwareLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
        const path = workspaceFilePath(href);
        if (path) {
          const open = (event: MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            openFile(path);
          };
          return (
            <a href={href} title={title ?? path} onClick={open} aria-label={t('fileLinks.openInFiles', { file: fileName(path) })}>
              {children}
            </a>
          );
        }
        const external = /^https?:\/\//i.test(href ?? '');
        return (
          <a
            href={href}
            title={title}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
          >
            {children}
          </a>
        );
      },
    };
  }, [openFile, t]);
}

function documentLabel(document: ProductDocument, t: ReturnType<typeof useTranslation<'chat'>>['t'], uiLanguage: string, translated: boolean) {
  const name = t(`fileLinks.document.${document.kind}`);
  // When a message links the same document in two languages, each button names its language.
  const language = document.language ?? (translated ? uiLanguage : undefined);
  return language
    ? t('fileLinks.openDocumentIn', { document: name, language: language.toUpperCase() })
    : t('fileLinks.openDocument', { document: name });
}

/**
 * One button per Product document a message links (research, brief, spec, tasks, and a brief's copy in
 * the client's language), so the person opens it for review in the Files panel with one click. Drawn
 * under an agent's message, only in a session with a Files panel.
 */
export function WorkspaceDocumentButtons({ text }: { text: string }) {
  const openFile = useContext(WorkspacePanelContext)?.openFile;
  const { t, i18n } = useTranslation('chat');
  const documents = useMemo(() => linkedProductDocuments(text), [text]);
  if (!openFile || documents.length === 0) return null;
  const uiLanguage = (i18n.resolvedLanguage ?? i18n.language ?? 'uk').slice(0, 2);
  return (
    <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('fileLinks.documents')}>
      {documents.map(document => {
        // The team's copy has no language in its name; it is the person's language, which is the UI's,
        // unless that is the language of the client's copy beside it.
        const translations = documents.filter(
          other => other !== document && other.kind === document.kind && other.language !== document.language,
        );
        const translated = translations.length > 0 && translations.every(other => other.language !== uiLanguage);
        return (
          <Button
            key={document.path}
            type="button"
            size="sm"
            icon={<FileText />}
            title={document.path}
            onClick={() => openFile(document.path)}
          >
            {documentLabel(document, t, uiLanguage, translated)}
          </Button>
        );
      })}
    </div>
  );
}
