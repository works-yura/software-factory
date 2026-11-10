import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { InlineCode } from '@mastra/playground-ui/components/InlineCode';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';

import type { ServerStatusProblem } from '../../hooks/useServerStatus';
import { translator } from '../i18n/t';

const tk = translator('app');

/** The banner copy in the reader's language for problems the UI knows; the server's English copy otherwise. */
function problemCopy(problem: ServerStatusProblem): Pick<ServerStatusProblem, 'title' | 'message' | 'fix'> {
  if (problem.code !== 'secret_key_mismatch') return problem;
  return {
    title: tk('serverProblem.secretKey.title'),
    message:
      problem.reason === 'missing_key'
        ? tk('serverProblem.secretKey.missingKey')
        : tk('serverProblem.secretKey.changedKey'),
    fix: tk('serverProblem.secretKey.fix'),
  };
}

/** Renders a fix step, turning backticked env var names into copyable code. */
function FixStep({ fix }: { fix: string }) {
  return (
    <Txt as="span" variant="body-sm" tone="ink">
      {fix.split('`').map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="inline-flex items-center gap-0.5 align-middle">
            <InlineCode>{part}</InlineCode>
            <CopyButton content={part} tooltip={tk('serverProblem.copy', { value: part })} />
          </span>
        ) : (
          part
        ),
      )}
    </Txt>
  );
}

/**
 * Full-width banner above every page while the server reports a problem that stops Factory
 * from working. No dismiss: it stays until the server is fixed and redeployed.
 */
export function ServerProblemBanner({ problem }: { problem: ServerStatusProblem }) {
  const { title, message, fix } = problemCopy(problem);
  return (
    <div
      role="alert"
      className="border-surface-rim bg-destructive-subtle text-destructive-indicator flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-0">
        <TriangleAlertIcon className="size-icon-md shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Txt as="h2" variant="label" tone="ink" className="shrink-0">
            {title}
          </Txt>
          <Txt as="span" variant="body-sm" tone="ink">
            {message}
          </Txt>
          {fix ? <FixStep fix={fix} /> : null}
        </div>
      </div>
      {problem.docsUrl ? (
        <div className="ml-auto flex shrink-0 items-center">
          <Button
            render={<a href={problem.docsUrl} target="_blank" rel="noopener noreferrer" />}
            variant="default"
            size="md"
            iconEnd={<ExternalLinkIcon aria-hidden />}
          >
            {tk('serverProblem.readDocs')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
