import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CodeDiff } from '@mastra/playground-ui/components/CodeDiff';
import { CodeEditor } from '@mastra/playground-ui/components/CodeEditor';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantBehavior, useBehaviorActions } from './settings-api';
import { RequestTime } from './time';

type DocumentTab = 'edit' | 'preview' | 'diff';

/**
 * A Markdown document as the project edits one (the skill editor's way): CodeEditor in markdown,
 * MarkdownRenderer to preview it, and — when there is something to compare with — CodeDiff.
 */
export function MarkdownDocumentEditor({
  value,
  onChange,
  compareWith,
  readOnly = false,
  label,
}: {
  value: string;
  onChange?: (value: string) => void;
  /** The text the diff tab compares with (the default, an original); no diff tab without it. */
  compareWith?: string;
  readOnly?: boolean;
  label: string;
}) {
  const { t } = useTranslation('assistant');
  const [tab, setTab] = useState<DocumentTab>('edit');
  return (
    <Tabs defaultTab="edit" value={tab} onValueChange={setTab}>
      <TabList size="sm">
        <Tab value="edit">{readOnly ? t('document.text') : t('document.edit')}</Tab>
        <Tab value="preview">{t('document.preview')}</Tab>
        {compareWith !== undefined ? <Tab value="diff">{t('document.diff')}</Tab> : null}
      </TabList>
      <TabContent value="edit">
        <CodeEditor
          aria-label={label}
          data-testid="assistant-document-editor"
          value={value}
          onChange={onChange}
          language="markdown"
          editable={!readOnly}
          showCopyButton={false}
          className="h-[50vh]"
        />
      </TabContent>
      <TabContent value="preview">
        <div className="border-border max-h-[50vh] overflow-y-auto rounded-lg border p-4">
          <MarkdownRenderer>{value}</MarkdownRenderer>
        </div>
      </TabContent>
      {compareWith !== undefined ? (
        <TabContent value="diff">
          {compareWith === value ? (
            <Txt as="p" variant="caption" tone="muted">
              {t('document.noDiff')}
            </Txt>
          ) : (
            <CodeDiff codeA={compareWith} codeB={value} layout="unified" />
          )}
        </TabContent>
      ) : null}
    </Tabs>
  );
}

/**
 * Settings › «Помічник» › Поведінка: the base instructions as one document. The shipped text is the
 * default; the person's version replaces it (with the diff against the default) until «Restore
 * default». Their old «own instructions» are already merged into it.
 */
export function AssistantBehaviorSettings() {
  const { t } = useTranslation('assistant');
  const behavior = useAssistantBehavior();
  const actions = useBehaviorActions();
  const [draft, setDraft] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (behavior.data) setDraft(behavior.data.document);
  }, [behavior.data]);

  if (behavior.isError) return <Notice variant="destructive">{behavior.error.message}</Notice>;
  if (!behavior.data || draft === undefined) return <Skeleton className="h-40 w-full" />;
  const { data } = behavior;
  const changed = draft !== data.document;

  return (
    <SettingsContainer>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {data.customized ? (
            <Badge size="sm" variant="info">
              {t('behavior.customized')}
            </Badge>
          ) : (
            <Badge size="sm" variant="neutral">
              {t('behavior.default')}
            </Badge>
          )}
          {data.updatedAt ? (
            <Txt as="span" variant="caption" tone="muted">
              {t('behavior.changed')} <RequestTime value={data.updatedAt} />
            </Txt>
          ) : null}
          <Txt as="span" variant="caption" tone="muted" title={t('behavior.versionHint')}>
            {t('behavior.version', { version: data.version })}
          </Txt>
        </div>
        <Txt as="p" variant="caption" tone="muted">
          {t('behavior.hint')}
        </Txt>
        <MarkdownDocumentEditor value={draft} onChange={setDraft} compareWith={data.defaultDocument} label={t('behavior.editor')} />
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={!changed || actions.save.isPending} onClick={() => actions.save.mutate(draft)}>
            {t('behavior.save')}
          </Button>
          {changed ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft(data.document)}>
              {t('behavior.discard')}
            </Button>
          ) : null}
          {data.customized ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={actions.reset.isPending} onClick={() => actions.reset.mutate()}>
              {t('behavior.reset')}
            </Button>
          ) : null}
        </div>
        {actions.save.isError ? <Notice variant="destructive">{actions.save.error.message}</Notice> : null}
        {actions.reset.isError ? <Notice variant="destructive">{actions.reset.error.message}</Notice> : null}
      </div>
    </SettingsContainer>
  );
}
