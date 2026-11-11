import type { ToolEdit } from './tool-presentation';
import { useHighlight } from '@/ds/components/Code';
import { CodeBlock } from '@/ds/components/CodeBlock';
import { languageForPath } from '@/ds/components/CodeEditor/highlight';
import { truncateString } from '@/lib/truncate-string';
import { cn } from '@/lib/utils';
import { libText } from '@/lib/lib-text';

const DIFF_MAX_LINES = 200;
const WRITTEN_FILE_MAX_CHARS = 2000;

const DIFF_SIDES = {
  removed: { sign: '-', row: 'bg-destructive-subtle', gutter: 'text-destructive-subtle-foreground' },
  added: { sign: '+', row: 'bg-success-subtle', gutter: 'text-success-subtle-foreground' },
} as const;

type UnifiedLine = { kind: 'removed' | 'added' | 'context' | 'hunk'; text: string };

/** A unified diff's lines by kind; file headers (`---`, `+++`, `diff`, `index`) are dropped. */
export function unifiedDiffLines(diff: string): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (/^(?:---|\+\+\+|diff |index |\\ No newline)/.test(line)) continue;
    if (line.startsWith('@@')) lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('-')) lines.push({ kind: 'removed', text: line.slice(1) });
    else if (line.startsWith('+')) lines.push({ kind: 'added', text: line.slice(1) });
    else lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  return lines;
}

/** How many lines a change adds and removes: the card's `+N −M`, as a code review shows it. */
export function editLineCounts(edit: ToolEdit): { added: number; removed: number } | undefined {
  if ('content' in edit) return undefined;
  if ('diff' in edit) {
    const lines = unifiedDiffLines(edit.diff);
    return { added: lines.filter(line => line.kind === 'added').length, removed: lines.filter(line => line.kind === 'removed').length };
  }
  const count = (text: string) => (text === '' ? 0 : text.split('\n').length);
  return { added: count(edit.newText), removed: count(edit.oldText) };
}

function LineCounts({ edit }: { edit: ToolEdit }) {
  const counts = editLineCounts(edit);
  if (!counts || (counts.added === 0 && counts.removed === 0)) return null;
  return (
    <div className="flex gap-2 pb-1 font-mono text-caption" data-testid="tool-call-edit-counts" aria-label={libText('Lines added and removed')}>
      <span className="text-success-subtle-foreground">+{counts.added}</span>
      <span className="text-destructive-subtle-foreground">−{counts.removed}</span>
    </div>
  );
}

/** A unified diff drawn as the replacement card draws its sides: removed red, added green, context plain. */
function UnifiedDiff({ diff, lang, showFullContent }: { diff: string; lang: string | undefined; showFullContent: boolean }) {
  const all = unifiedDiffLines(diff);
  const lines = showFullContent ? all : all.slice(0, DIFF_MAX_LINES);
  const hidden = all.length - lines.length;
  const code = lines.map(line => line.text).join('\n');
  const highlighted = useHighlight(code, lang);
  const tokens = highlighted?.code === code ? highlighted.tokens : undefined;
  return (
    <div
      className={cn(
        'max-w-full min-w-0 overflow-x-auto rounded-md border border-border bg-fill font-mono text-caption',
        showFullContent && 'max-h-60 overflow-y-auto',
      )}
      role="group"
      aria-label={libText('File change')}
    >
      {lines.map((line, index) => {
        if (line.kind === 'hunk') {
          return (
            <div key={index} className="px-2.5 whitespace-pre text-muted-foreground select-none">
              {line.text}
            </div>
          );
        }
        const side = line.kind === 'context' ? undefined : DIFF_SIDES[line.kind];
        return (
          <div key={index} className={cn('flex whitespace-pre', side?.row)} data-diff-line={line.kind}>
            <span className={cn('w-5 shrink-0 text-center opacity-70 select-none', side?.gutter)}>{side?.sign ?? ' '}</span>
            <span className="flex-1 pr-2.5 text-foreground">
              {tokens?.[index]?.map((token, tokenIndex) => (
                <span key={tokenIndex} className={token.className}>
                  {token.content}
                </span>
              )) ?? line.text}
            </span>
          </div>
        );
      })}
      {hidden > 0 && <div className="px-2.5 py-1 text-muted-foreground select-none">… {hidden} more lines</div>}
    </div>
  );
}

function boundedLines(text: string, showFullContent: boolean): { lines: string[]; hidden: number } {
  const lines = text.split('\n');
  if (showFullContent) return { lines, hidden: 0 };
  return { lines: lines.slice(0, DIFF_MAX_LINES), hidden: Math.max(0, lines.length - DIFF_MAX_LINES) };
}

function DiffSide({ lines, side, lang }: { lines: string[]; side: keyof typeof DIFF_SIDES; lang: string | undefined }) {
  const { sign, row, gutter } = DIFF_SIDES[side];
  const code = lines.join('\n');
  const highlighted = useHighlight(code, lang);
  const tokens = highlighted?.code === code ? highlighted.tokens : undefined;

  return (
    <>
      {lines.map((line, index) => (
        <div key={index} className={cn('flex whitespace-pre', row)}>
          <span className={cn('w-5 shrink-0 text-center opacity-70 select-none', gutter)}>{sign}</span>
          <span className="flex-1 pr-2.5 text-foreground">
            {tokens?.[index]?.map((token, tokenIndex) => (
              <span key={tokenIndex} className={token.className}>
                {token.content}
              </span>
            )) ?? line}
          </span>
        </div>
      ))}
    </>
  );
}

export function ToolCallEdit({ edit, showFullContent = false }: { edit: ToolEdit; showFullContent?: boolean }) {
  const lang = languageForPath(edit.path);

  if ('diff' in edit) {
    return (
      <div className="min-w-0">
        <LineCounts edit={edit} />
        <UnifiedDiff diff={edit.diff} lang={lang} showFullContent={showFullContent} />
      </div>
    );
  }

  if ('content' in edit) {
    return (
      <CodeBlock
        code={showFullContent ? edit.content : truncateString(edit.content, WRITTEN_FILE_MAX_CHARS)}
        lang={lang}
        fileName={edit.path ?? libText('Change')}
        overflow="scroll"
      />
    );
  }

  const removed = boundedLines(edit.oldText, showFullContent);
  const added = boundedLines(edit.newText, showFullContent);
  const hidden = removed.hidden + added.hidden;

  return (
    <div className="min-w-0">
      <LineCounts edit={edit} />
      <div
        className={cn(
          'max-w-full min-w-0 overflow-x-auto rounded-md border border-border bg-fill font-mono text-caption',
          showFullContent && 'max-h-60 overflow-y-auto',
        )}
        role="group"
        aria-label={libText('File change')}
      >
        <DiffSide lines={removed.lines} side="removed" lang={lang} />
        <DiffSide lines={added.lines} side="added" lang={lang} />
        {hidden > 0 && <div className="px-2.5 py-1 text-muted-foreground select-none">… {hidden} more lines</div>}
      </div>
    </div>
  );
}
