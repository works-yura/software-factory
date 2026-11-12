import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { GoogleIcon } from '@mastra/playground-ui/icons/GoogleIcon';
import { ListChecks, Server } from 'lucide-react';

import { GitLabIcon } from '../../../../ui/icons';
import type { ConnectionKind } from '../../connections/connections';

/** The integration's mark in a 32px tile, the same in the list, the detail and «Додати підключення». */
export function ConnectionIcon({ kind }: { kind: ConnectionKind }) {
  const icon =
    kind === 'google-cloud' ? (
      <GoogleIcon className="size-4" />
    ) : kind === 'github' ? (
      <GithubIcon className="size-4" />
    ) : kind === 'gitlab' ? (
      <GitLabIcon size={16} />
    ) : kind === 'clickup' ? (
      <ListChecks className="size-4" />
    ) : (
      <Server className="size-4" />
    );
  return (
    <span aria-hidden className="border-border1 bg-surface2 flex size-8 shrink-0 items-center justify-center rounded-md border">
      {icon}
    </span>
  );
}
