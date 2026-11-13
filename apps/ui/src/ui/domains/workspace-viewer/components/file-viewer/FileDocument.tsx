import { Code } from '@mastra/playground-ui/components/Code';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { useRef } from 'react';

import type { WorkspaceFilePreview } from '../workspace-file-preview';
import { FileAnnotations } from './FileAnnotations';

/**
 * A text file's body: markdown rendered and open to notes (long lines wrap; code blocks and tables
 * scroll on their own), anything else as highlighted code.
 */
export function FileDocument({ file, filePath }: { file: WorkspaceFilePreview; filePath: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const content = file.content ?? '';
  if (file.language !== 'markdown') {
    return (
      <Code
        code={content}
        lang={file.language}
        className="border-border bg-background text-caption text-foreground m-0 rounded-md border p-3 font-mono"
      />
    );
  }
  return (
    <div
      ref={ref}
      className="relative min-w-0 wrap-anywhere [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto"
    >
      {/* The slot annotations select from, as a chat message marks its content. */}
      <div data-slot="message-content">
        <MarkdownRenderer>{content}</MarkdownRenderer>
      </div>
      <FileAnnotations containerRef={ref} filePath={filePath} source={content} />
    </div>
  );
}
