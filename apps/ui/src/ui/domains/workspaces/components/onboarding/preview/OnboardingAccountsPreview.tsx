import type { ReactNode } from 'react';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Building2, Sparkles, UserRound } from 'lucide-react';
import { CONNECTION_METHOD_LABEL } from '../../../hooks/useProviderConnection';
import type { OnboardingPreviewProps } from './OnboardingPreview';
import { SketchLabel } from './SketchLabel';
import { OnboardingModelLabel } from './OnboardingModelLabel';
import { translator } from '../../../../../i18n/t';

const tk = translator('workspaces');

function workAccountLabel(local: boolean) {
  if (local) return tk('accountsPreview.localAccount');
  return tk('onboarding.setups.factory.label');
}

function workSourceLabel(local: boolean) {
  if (local) return tk('accountsPreview.localAccount');
  return tk('accountsPreview.company');
}

export function OnboardingAccountsPreview({
  local = false,
  model,
  providerId,
  connectionMethod,
}: OnboardingPreviewProps) {
  const accountLabel = workAccountLabel(local);
  const sourceLabel = workSourceLabel(local);
  return (
    <section aria-label={tk('accountsPreview.label')} className="onboarding-account-labels relative h-full">
      <AccountSource x={148} label={sourceLabel} icon={<Building2 />} />
      <SessionIllustration x={148} label={tk('accountsPreview.team')} />
      <SessionIllustration x={268} label={tk('accountsPreview.you')} />
      <SketchLabel x={28} y={260} width={104}>
        <Txt variant="meta" tone="muted">
          {tk('accountsPreview.factoryWork')}
        </Txt>
      </SketchLabel>
      <SketchLabel x={148} y={260} width={104}>
        <Txt variant="meta" tone="muted">
          {tk('accountsPreview.teamSessions')}
        </Txt>
      </SketchLabel>
      <SketchLabel x={268} y={260} width={104}>
        <Txt variant="meta" tone="muted">
          {tk('accountsPreview.yourSessions')}
        </Txt>
      </SketchLabel>
      <div className="onboarding-scene-detail absolute inset-x-7 top-[89%] grid grid-cols-2 gap-6">
        <div role="group" aria-label={tk('accountsPreview.workModel')} className="min-w-0">
          <Txt variant="meta" className="mb-2">
            {accountLabel}
          </Txt>
          <OnboardingModelLabel providerId={providerId} model={model} />
          {connectionMethod && (
            <Txt variant="meta" tone="muted" className="mt-2">
              {CONNECTION_METHOD_LABEL[connectionMethod]}
            </Txt>
          )}
        </div>
        <div role="group" aria-label={tk('accountsPreview.sessionModel')} className="min-w-0">
          <Txt variant="meta" className="mb-2">
            {tk('accountsPreview.sameModel')}
          </Txt>
          <OnboardingModelLabel providerId={providerId} model={model} />
        </div>
      </div>
    </section>
  );
}

function AccountSource({ x, label, icon }: { x: number; label: string; icon: ReactNode }) {
  return (
    <SketchLabel x={x + 10} y={62} width={84}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground hidden size-3 shrink-0 min-[900px]:inline [&>svg]:size-3">{icon}</span>
        <Txt variant="meta">{label}</Txt>
      </div>
    </SketchLabel>
  );
}

function SessionIllustration({ x, label }: { x: number; label: string }) {
  return (
    <SketchLabel x={x + 10} y={169} width={84}>
      <div className="flex items-center gap-2">
        <UserRound className="text-muted-foreground hidden size-3 shrink-0 min-[900px]:block" />
        <Txt variant="meta">{label}</Txt>
      </div>
      <div className="bg-fill mt-3 h-1 rounded-full min-[900px]:mt-4 min-[900px]:h-3" />
      <div className="text-muted-foreground mt-3 hidden items-center gap-2 min-[900px]:flex">
        <Sparkles className="size-3 shrink-0" />
        <div className="bg-fill h-1 w-full rounded-full" />
      </div>
    </SketchLabel>
  );
}
