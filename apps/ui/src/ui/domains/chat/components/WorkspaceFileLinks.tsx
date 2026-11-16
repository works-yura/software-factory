import { Button } from '@mastra/playground-ui/components/Button';
import type { MarkdownRendererProps } from '@mastra/playground-ui/components/MarkdownRenderer';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Copy, ExternalLink, FileText, PanelRight } from 'lucide-react';
import { useContext, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { WorkspacePanelContext } from '../../workspace-viewer/context/WorkspacePanelContext';
import { linkedProductDocuments, workspaceFilePath } from '../../workspace-viewer/workspace-file-link';
import type { ProductDocument } from '../../workspace-viewer/workspace-file-link';
import { FILE_LINK_PLUGINS, isFilePath } from '../../workspace-viewer/remark-file-links';

type MarkdownComponents = NonNullable<MarkdownRendererProps['components']>;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/:\d+(?:[:-]\d+)?$/, '');

const WEB_ADDRESS = /^https?:\/\//i;

/** What a link in the chat points at, which decides what clicking it offers. */
export type ChatLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'web'; url: string }
  /** A file path outside the session's workspace, e.g. under `/tmp` on the server: it can only be copied. */
  | { kind: 'outside'; path: string };

export function chatLinkTarget(href: string | undefined): ChatLinkTarget | undefined {
  if (!href) return undefined;
  if (WEB_ADDRESS.test(href)) return { kind: 'web', url: href };
  const path = workspaceFilePath(href);
  if (path) return { kind: 'file', path };
  if ((href.startsWith('/') || href.startsWith('~/')) && isFilePath(href)) return { kind: 'outside', path: href };
  return undefined;
}

const MODIFIER_HINT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const hasModifier = (event: { metaKey: boolean; ctrlKey: boolean }) => event.metaKey || event.ctrlKey;

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/**
 * A link in a session chat. A click opens a menu of what can be done with it, headed by where it
 * points; ⌘/Ctrl-click does the first item at once: a workspace file opens in the Files panel, a web
 * address in a new tab. A path outside the workspace cannot be opened from the browser, so its menu
 * only copies it.
 */
function ChatLink({
  href,
  title,
  target,
  openFile,
  children,
}: {
  href: string;
  title?: string;
  target: ChatLinkTarget;
  openFile: (path: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const shown = target.kind === 'web' ? target.url : target.path;

  const openNow = () => {
    if (target.kind === 'file') openFile(target.path);
    if (target.kind === 'web') window.open(target.url, '_blank', 'noopener,noreferrer');
  };

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // ⌘/Ctrl-click on a web address is the browser's own new tab; let it be.
    if (hasModifier(event) && target.kind === 'web') return;
    event.preventDefault();
    if (hasModifier(event) && target.kind === 'file') openFile(target.path);
  };

  const label =
    target.kind === 'file'
      ? t('fileLinks.openInFiles', { file: fileName(target.path) })
      : target.kind === 'web'
        ? t('fileLinks.webLink', { url: target.url })
        : t('fileLinks.outsidePath', { file: fileName(target.path) });

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        const event = details?.event as { metaKey?: boolean; ctrlKey?: boolean } | undefined;
        if (next && event && (event.metaKey || event.ctrlKey)) return;
        setOpen(next);
      }}
    >
      <DropdownMenu.Trigger
        nativeButton={false}
        render={
          <a
            href={href}
            title={title ?? shown}
            onClick={onClick}
            aria-label={label}
            target={target.kind === 'web' ? '_blank' : undefined}
            rel={target.kind === 'web' ? 'noopener noreferrer' : undefined}
          />
        }
      >
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenu.Label className="line-clamp-2 break-all font-mono text-xs normal-case tracking-normal">{shown}</DropdownMenu.Label>
        <DropdownMenu.Separator />
        {target.kind === 'file' ? (
          <DropdownMenu.Item onClick={openNow}>
            <PanelRight />
            {t('fileLinks.menu.openInFiles')}
            <DropdownMenu.Shortcut className="[@media(hover:none)]:hidden">{MODIFIER_HINT} Click</DropdownMenu.Shortcut>
          </DropdownMenu.Item>
        ) : null}
        {target.kind === 'web' ? (
          <DropdownMenu.Item onClick={openNow}>
            <ExternalLink />
            {t('fileLinks.menu.openInTab')}
            <DropdownMenu.Shortcut className="[@media(hover:none)]:hidden">{MODIFIER_HINT} Click</DropdownMenu.Shortcut>
          </DropdownMenu.Item>
        ) : null}
        {target.kind === 'outside' ? (
          <DropdownMenu.Label className="text-xs font-normal normal-case tracking-normal">{t('fileLinks.menu.outside')}</DropdownMenu.Label>
        ) : null}
        <DropdownMenu.Item onClick={() => copy(shown)}>
          <Copy />
          {target.kind === 'web' ? t('fileLinks.menu.copyLink') : t('fileLinks.menu.copyPath')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/**
 * Markdown overrides for a session chat: a link to a workspace file, a web address, or a path on the
 * server opens a menu (see `ChatLink`); file paths written as text or `code` are links too
 * (`FILE_LINK_PLUGINS`). Undefined outside a session with a Files panel, so the renderer keeps its own
 * links there.
 */
export function useWorkspaceFileLinkComponents(): MarkdownComponents | undefined {
  const openFile = useContext(WorkspacePanelContext)?.openFile;
  return useMemo(() => {
    if (!openFile) return undefined;
    return {
      a: function WorkspaceAwareLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
        const target = chatLinkTarget(href);
        if (target && href) {
          return (
            <ChatLink href={href} title={title} target={target} openFile={openFile}>
              {children}
            </ChatLink>
          );
        }
        return (
          <a href={href} title={title}>
            {children}
          </a>
        );
      },
    };
  }, [openFile]);
}

/** The remark plugins that go with `useWorkspaceFileLinkComponents`: undefined where those are. */
export function useWorkspaceFileLinkPlugins(): typeof FILE_LINK_PLUGINS | undefined {
  return useContext(WorkspacePanelContext)?.openFile ? FILE_LINK_PLUGINS : undefined;
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
