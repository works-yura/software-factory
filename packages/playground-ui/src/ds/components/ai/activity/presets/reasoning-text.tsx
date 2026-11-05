import type { ReasoningContent } from './reasoning-visibility';
import { MarkdownRenderer } from '@/ds/components/MarkdownRenderer';
import { libText } from '@/lib/lib-text';

export interface ReasoningTextProps {
  content: ReasoningContent;
  className?: string;
}

export function ReasoningText({ content: { text, redacted, streaming }, className }: ReasoningTextProps) {
  return (
    <MarkdownRenderer className={className} streaming={streaming && !redacted}>
      {redacted ? libText('Reasoning was redacted by the provider.') : text}
    </MarkdownRenderer>
  );
}
