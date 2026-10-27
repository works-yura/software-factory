import { providerDisplayName } from '@factory/credentials/provider-display-name';
import type { ModelCredentialHolder } from '@factory/api/config';
import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Building2, KeyRound, Server, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { translator } from '../../../../i18n/t';

import { useAvailableModelsQuery } from '../../../../../hooks/useAvailableModels';
import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { ProviderBrandIcon } from '../../../workspaces/components/ProviderBrandIcon';
import { useChatModels } from '../../context/useChatModels';
import { useChatModelCatalog } from '../../context/useChatModelCatalog';
import { useChatSessionContext } from '../../context/useChatSessionContext';
import type { ThreadOwner } from '../../services/reply-credential';
import type { FactoryAuthState } from '../../../auth/services/auth';

const tk = translator('chat');

type CredentialHolder =
  | { kind: 'organization' }
  | { kind: 'deployment' }
  | { kind: 'teammate-owner'; name?: string; avatarUrl?: string }
  | { kind: 'you'; name?: string; avatarUrl?: string; ownsSession: boolean };

function personalHolder(
  owner: ThreadOwner | undefined,
  viewer: FactoryAuthState['user'],
  isDraft: boolean,
): CredentialHolder {
  if (owner && owner.id !== viewer?.userId) {
    return { kind: 'teammate-owner', name: owner.name, avatarUrl: owner.avatarUrl };
  }
  const you = owner ?? { name: viewer?.name, avatarUrl: viewer?.avatarUrl };
  return { kind: 'you', name: you.name, avatarUrl: you.avatarUrl, ownsSession: Boolean(owner) || isDraft };
}

function resolveHolder(
  credentialHolder: ModelCredentialHolder,
  owner: ThreadOwner | undefined,
  viewer: FactoryAuthState['user'],
  isDraft: boolean,
): CredentialHolder {
  switch (credentialHolder) {
    case 'organization':
      return { kind: 'organization' };
    case 'deployment':
      return { kind: 'deployment' };
    case 'personal':
      return personalHolder(owner, viewer, isDraft);
    default:
      return credentialHolder satisfies never;
  }
}

function describeHolder(holder: CredentialHolder): string {
  if (holder.kind === 'organization') return tk('credential.organization');
  if (holder.kind === 'deployment') return tk('credential.deployment');
  if (holder.kind === 'teammate-owner') {
    return holder.name ? tk('credential.ownerNamed', { name: holder.name }) : tk('credential.owner');
  }
  if (!holder.ownsSession) return holder.name ? tk('credential.youNamed', { name: holder.name }) : tk('credential.you');
  return holder.name ? tk('credential.youOwnerNamed', { name: holder.name }) : tk('credential.youOwner');
}

function teammateWarning(holder: CredentialHolder, credential: string): string | undefined {
  if (holder.kind !== 'teammate-owner') return undefined;
  return holder.name
    ? tk('credential.teammateWarningNamed', { name: holder.name, credential })
    : tk('credential.teammateWarning', { credential });
}

const badgeShell = 'flex size-icon-sm items-center justify-center rounded-full border border-border bg-card';

function GlyphBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={badgeShell}>
      <Icon className="size-2.5" />
    </span>
  );
}

function HolderBadge({ holder }: { holder: CredentialHolder }) {
  if (holder.kind === 'organization') return <GlyphBadge icon={Building2} />;
  if (holder.kind === 'deployment') return <GlyphBadge icon={Server} />;
  if (!holder.name) return <GlyphBadge icon={User} />;
  return (
    <span className="[&>[data-slot=avatar]]:size-icon-sm flex">
      <Avatar name={holder.name} src={holder.avatarUrl} size="xs" />
    </span>
  );
}

export function ModelCredential() {
  const authQuery = useFactoryAuth();
  const { owner, draftSessionId } = useChatSessionContext();
  const { activeModelId } = useChatModels();
  const { catalogTarget } = useChatModelCatalog();
  const modelsQuery = useAvailableModelsQuery(catalogTarget);
  const model = modelsQuery.data?.find(candidate => candidate.id === activeModelId);

  if (!authQuery.data?.authEnabled || !model?.credentialHolder) return null;

  const holder = resolveHolder(model.credentialHolder, owner, authQuery.data.user, Boolean(draftSessionId));
  const credential = model.credentialLabel ?? tk('credential.connection', { provider: providerDisplayName(model.provider) });
  const holderDescription = describeHolder(holder);
  const warning = teammateWarning(holder, credential);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={[credential, holderDescription, warning].filter(Boolean).join('. ')}
            className={cn(
              'relative flex size-avatar-sm shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground',
              focusRing,
            )}
          />
        }
      >
        <ProviderBrandIcon provider={model.provider} fallback={<KeyRound className="size-3.5" />} />
        <span className="absolute -right-1 -bottom-1">
          <HolderBadge holder={holder} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="grid gap-1">
        <span className="font-medium">{credential}</span>
        <span className="text-muted-foreground flex items-center gap-1.5">
          <HolderBadge holder={holder} />
          {holderDescription}
        </span>
        {warning ? <span className="text-warning-foreground">{warning}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
