import { ActivityItem } from '@mastra/playground-ui/components/ai/activity';
import { presentTool, ToolCallBody } from '@mastra/playground-ui/components/ai/tool-call';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { DisclosureChevron } from '@mastra/playground-ui/components/DisclosureChevron';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePendingAction } from './api';
import type { AssistantRequest, PendingAction, ToolCallRecord, TurnDetails } from './api';
import { useModelLabel } from './RequestThread';
import { RequestTime } from './time';

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One tool call as Factory's chats draw one: the tool's icon and label, its arguments and answer when opened. */
function ToolCallRow({ call }: { call: ToolCallRecord }) {
  const { t } = useTranslation('assistant');
  const args = parsed(call.args);
  const { icon: Icon, label } = presentTool(call.name, args);
  const status = call.error ? 'error' : 'idle';
  return (
    <ActivityItem
      icon={<Icon aria-hidden />}
      label={label}
      detail={`${call.name} · ${t('details.ms', { ms: call.durationMs })}`}
      status={status}
      aria-label={t('details.call', { name: call.name })}
      data-testid="assistant-tool-call"
    >
      <ToolCallBody toolName={call.name} args={args} argsText={call.args} status={status} result={call.error ?? (call.result !== undefined ? parsed(call.result) : undefined)} />
    </ActivityItem>
  );
}

/**
 * «Turn details» under an agent reply, collapsed: the model that ran, the system prompt's version
 * (as «What the agent sees» names it), the skills it could load, and every tool call with its outcome.
 */
export function TurnDetailsView({ details }: { details: TurnDetails }) {
  const { t } = useTranslation('assistant');
  const label = useModelLabel();
  return (
    <Collapsible data-testid="assistant-turn-details">
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm">
        <DisclosureChevron />
        <Txt as="span" variant="caption" tone="muted">
          {t('details.title')}
          {details.toolCalls.length ? ` · ${t('details.calls', { count: details.toolCalls.length })}` : ''}
        </Txt>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1 py-1">
          <Txt as="p" variant="caption" tone="muted">
            {[
              t('details.model', { model: details.modelId ? label(details.modelId) : t('failure.defaultModel') }),
              t('details.version', { version: details.instructionsVersion }),
              details.skills.length ? t('details.skills', { skills: details.skills.join(', ') }) : t('details.noSkills'),
              t('details.ms', { ms: details.durationMs }),
            ].join(' · ')}
          </Txt>
          {details.toolCalls.length === 0 ? (
            <Txt as="p" variant="caption" tone="muted">
              {t('details.noCalls')}
            </Txt>
          ) : (
            details.toolCalls.map((call, index) => <ToolCallRow key={`${call.name}-${index}`} call={call} />)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const CONFIRM_LABEL = {
  ask: 'pending.confirmAsk',
  hand_over: 'pending.confirmHandOver',
  workspace_tool: 'pending.confirmRun',
  download: 'pending.confirmDownload',
} as const satisfies Record<PendingAction['kind'], string>;

/**
 * A Factory action the agent (or a channel rule) proposed: what would run, why, and Confirm / Cancel.
 * Nothing runs in a Factory until the person confirms.
 */
export function PendingActionCard({ request, action }: { request: AssistantRequest; action: PendingAction }) {
  const { t } = useTranslation('assistant');
  const pending = usePendingAction(request.id);
  const busy = pending.confirm.isPending || pending.cancel.isPending;
  const error = pending.confirm.error ?? pending.cancel.error;
  return (
    <div data-testid="assistant-pending-action" role="group" aria-label={t('pending.label')}>
      <Notice
        variant="info"
        action={
          <span className="flex flex-wrap items-center gap-2">
            <Notice.Button icon={<Check />} disabled={busy} onClick={() => pending.confirm.mutate(action.id)}>
              {t(CONFIRM_LABEL[action.kind])}
            </Notice.Button>
            <Notice.Button icon={<X />} disabled={busy} onClick={() => pending.cancel.mutate(action.id)}>
              {t('actions.cancel')}
            </Notice.Button>
          </span>
        }
      >
        <Txt as="span" variant="label">
          {action.kind === 'workspace_tool'
            ? t('pending.workspaceTool', { tool: action.toolName })
            : action.kind === 'download'
              ? t('pending.download', { name: action.name })
              : t(action.kind === 'ask' ? 'pending.ask' : 'pending.handOver', { factory: action.factoryName })}
        </Txt>
        <span className="flex flex-wrap items-center gap-2">
          <Badge size="xs" variant="neutral">
            {action.proposedBy === 'rule' ? t('pending.byRule') : t('pending.byAgent')}
          </Badge>
          <Txt as="span" variant="caption" tone="muted">
            <RequestTime value={action.proposedAt} />
          </Txt>
        </span>
        {action.reason ? <span>{action.reason}</span> : null}
        {action.kind === 'workspace_tool' ? (
          <pre className="bg-surface3 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">{action.summary}</pre>
        ) : null}
        {action.kind === 'download' ? (
          <Txt as="span" variant="body-sm" className="break-all font-mono">
            {action.url}
          </Txt>
        ) : null}
        {action.kind === 'workspace_tool' || action.kind === 'download' ? null : action.question ? (
          <Txt as="span" variant="body-sm" className="whitespace-pre-line">
            {t('pending.question')}: {action.question}
          </Txt>
        ) : null}
        {'title' in action && action.title ? (
          <Txt as="span" variant="body-sm">
            {t('pending.title')}: {action.title}
          </Txt>
        ) : null}
        {'note' in action && action.note ? (
          <Txt as="span" variant="body-sm" className="whitespace-pre-line">
            {action.note}
          </Txt>
        ) : null}
        {error ? <span role="alert">{error.message}</span> : null}
      </Notice>
    </div>
  );
}

/** Event lines (author `event`) of phase 3: what each says, for the transcript's divider. */
export function eventLabel(text: string, t: (key: string, options?: Record<string, unknown>) => string): { label: string; body?: string } | null {
  const [head = '', ...rest] = text.split('\n');
  const body = rest.join('\n').trim() || undefined;
  if (head === 'proposed:download') return { label: t('events.proposedDownload'), ...(body ? { body } : {}) };
  if (head.startsWith('proposed:workspace_tool:')) {
    return { label: t('events.proposedRun', { tool: head.slice('proposed:workspace_tool:'.length) }), ...(body ? { body } : {}) };
  }
  if (head.startsWith('ran:')) return { label: t('events.ran', { tool: head.slice('ran:'.length) }), ...(body ? { body } : {}) };
  if (head.startsWith('downloaded:')) return { label: t('events.downloaded', { path: head.slice('downloaded:'.length) }), ...(body ? { body } : {}) };
  if (head.startsWith('proposed:')) {
    const [, kind = '', ...name] = head.split(':');
    return { label: t(kind === 'ask' ? 'events.proposedAsk' : 'events.proposedHandOver', { factory: name.join(':') }), ...(body ? { body } : {}) };
  }
  if (head.startsWith('confirmed:')) return { label: t('events.confirmed') };
  if (head.startsWith('cancelled:')) return { label: t('events.cancelled') };
  if (head === 'rule:analyse_and_ask') return { label: t('events.ruleAsk') };
  if (head === 'auto_ask_failed') return { label: t('events.autoAskFailed'), ...(body ? { body } : {}) };
  if (head === 'answer_timeout') return { label: t('events.answerTimeout') };
  if (head === 'not_analysed:digest') return { label: t('events.digestOnly') };
  if (head.startsWith('digest:')) return { label: t('events.digest', { count: Number(head.slice('digest:'.length)) || 0 }) };
  return null;
}
