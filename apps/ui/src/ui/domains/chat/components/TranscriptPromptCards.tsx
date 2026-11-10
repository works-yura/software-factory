import type { PlanResume } from '@mastra/client-js';
import * as AskUser from '@mastra/playground-ui/components/ai/ask-user';
import type { AskUserAnswer, AskUserPayload } from '@mastra/playground-ui/components/ai/ask-user';
import { ToolApproval } from '@mastra/playground-ui/components/ai/tool-approval';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApprovalPrompt, SubagentEntry, SuspensionPrompt } from '../services/transcript';
import { AskUserPromptAnswers } from './AskUserPromptAnswers';
import { askUserQuestions } from '../services/askUserQuestions';
import { AskUserQuestionsCard } from './AskUserQuestionsCard';
import { SubmitPlanCard } from './SubmitPlanCard';

const promptCardSuspension =
  'border-border border-l-warning-indicator bg-fill my-2 min-w-0 rounded-lg border border-l-4 px-4 py-3';
const promptTitle = 'mb-1.5';
const promptActions = 'mt-2 flex gap-2';

function lastSegment(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}

function hasProperty<K extends string>(value: object, key: K): value is object & Record<K, unknown> {
  return key in value;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || !hasProperty(value, key)) return undefined;
  return typeof value[key] === 'string' ? value[key] : undefined;
}

export function ApprovalCard({
  prompt,
  isSubmitting,
  onApprove,
}: {
  prompt: ApprovalPrompt;
  isSubmitting: boolean;
  onApprove: (toolCallId: string, approved: boolean, promptId: string) => void;
}) {
  return (
    <ToolApproval
      toolName={prompt.toolName}
      args={prompt.args}
      autoFocus
      disabled={isSubmitting}
      onApprove={() => onApprove(prompt.toolCallId, true, prompt.id)}
      onDecline={() => onApprove(prompt.toolCallId, false, prompt.id)}
    />
  );
}

interface SuspendPayloadShape {
  question?: string;
  options?: AskUserPayload['options'];
  selectionMode?: AskUserPayload['selectionMode'];
  requestedPath?: string;
  reason?: string;
  plan?: { title?: string; summary?: string };
  title?: string;
}

function suspensionPayloadShape(payload: unknown): SuspendPayloadShape {
  const planValue = payload && typeof payload === 'object' && hasProperty(payload, 'plan') ? payload.plan : undefined;
  const plan =
    planValue && typeof planValue === 'object'
      ? {
          title: stringProperty(planValue, 'title'),
          summary: stringProperty(planValue, 'summary'),
        }
      : undefined;

  const optionsValue =
    payload && typeof payload === 'object' && hasProperty(payload, 'options') ? payload.options : undefined;
  const options = Array.isArray(optionsValue)
    ? optionsValue.flatMap(option => {
        const label = stringProperty(option, 'label');
        if (!label) return [];
        return [{ label, description: stringProperty(option, 'description') }];
      })
    : undefined;

  return {
    question: stringProperty(payload, 'question'),
    options,
    selectionMode: stringProperty(payload, 'selectionMode') === 'multi_select' ? 'multi_select' : 'single_select',
    requestedPath: stringProperty(payload, 'requestedPath') ?? stringProperty(payload, 'path'),
    reason: stringProperty(payload, 'reason'),
    title: stringProperty(payload, 'title'),
    plan,
  };
}

export function SuspensionCard({
  prompt,
  isSubmitting,
  onRespond,
}: {
  prompt: SuspensionPrompt;
  isSubmitting: boolean;
  onRespond: (toolCallId: string, resumeData: string | string[] | PlanResume, promptId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const payload = suspensionPayloadShape(prompt.suspendPayload);

  if (prompt.toolName === 'submit_plan') {
    return (
      <SubmitPlanCard
        toolCallId={prompt.toolCallId}
        input={prompt.suspendPayload}
        isSubmitting={isSubmitting}
        onRespond={response => onRespond(prompt.toolCallId, response, prompt.id)}
      />
    );
  }

  if (prompt.toolName === 'request_access') {
    const path = payload.requestedPath;
    return (
      <div className={promptCardSuspension} role="group" aria-label={t('prompts.accessRequest')}>
        <Txt as="p" variant="subheading" tone="ink" className={promptTitle}>
          {path ? t('prompts.grantAccessTo', { path }) : t('prompts.grantAccess')}
        </Txt>
        {payload.reason && (
          <Txt as="p" variant="caption" tone="muted" className="mt-0.5">
            {t('prompts.reason', { reason: payload.reason })}
          </Txt>
        )}
        <div className={promptActions}>
          <Button
            variant="primary"
            size="sm"
            aria-label={path ? t('prompts.allowAccessTo', { path }) : t('prompts.allowAccess')}
            autoFocus
            disabled={isSubmitting}
            onClick={() => onRespond(prompt.toolCallId, 'Yes', prompt.id)}
          >
            {t('prompts.allow')}
          </Button>
          <Button
            size="sm"
            aria-label={path ? t('prompts.denyAccessTo', { path }) : t('prompts.denyAccess')}
            disabled={isSubmitting}
            onClick={() => onRespond(prompt.toolCallId, 'No', prompt.id)}
          >
            {t('prompts.deny')}
          </Button>
        </div>
      </div>
    );
  }

  const questions = askUserQuestions(prompt.suspendPayload);
  if (questions) {
    return (
      <AskUserQuestionsCard
        key={prompt.id}
        questions={questions}
        isSubmitting={isSubmitting}
        onSubmit={answer => onRespond(prompt.toolCallId, answer, prompt.id)}
      />
    );
  }

  return <AskUserCard prompt={prompt} payload={payload} isSubmitting={isSubmitting} onRespond={onRespond} />;
}

function AskUserCard({
  prompt,
  payload,
  isSubmitting,
  onRespond,
}: {
  prompt: SuspensionPrompt;
  payload: SuspendPayloadShape;
  isSubmitting: boolean;
  onRespond: (toolCallId: string, resumeData: AskUserAnswer, promptId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const options = payload.options ?? [];
  const selectionMode = options.length > 0 ? payload.selectionMode : 'single_select';

  const handleAnswerSubmit = (answer: AskUserAnswer) => {
    onRespond(prompt.toolCallId, answer, prompt.id);
  };

  return (
    <AskUser.Root
      key={prompt.id}
      className="my-2"
      selectionMode={selectionMode}
      disabled={isSubmitting}
      onSubmit={handleAnswerSubmit}
    >
      <AskUser.Body>
        <AskUser.Question>{payload.question ?? t('prompts.agentQuestion')}</AskUser.Question>
        <AskUserPromptAnswers options={options} selectionMode={selectionMode} />
        {isSubmitting ? <AskUser.Pending className="mt-3 block" /> : null}
      </AskUser.Body>
    </AskUser.Root>
  );
}

/** Longer than this, a subagent's task or result starts folded. */
const SUBAGENT_FOLD_CHARS = 280;

/** Text that starts folded to a few lines when long, with a toggle to show it all. */
function FoldableText({ text, lines, tone }: { text: string; lines: 3 | 6; tone?: 'muted' }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const long = text.length > SUBAGENT_FOLD_CHARS || text.split('\n').length > lines;
  return (
    <div>
      <Txt
        variant="caption"
        tone={tone}
        className={`py-1 whitespace-pre-wrap wrap-anywhere ${long && !open ? (lines === 3 ? 'line-clamp-3' : 'line-clamp-6') : ''}`}
      >
        {text}
      </Txt>
      {long && (
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? t('prompts.subagentShowLess') : t('prompts.subagentShowMore')}
        </Button>
      )}
    </div>
  );
}

export function SubagentCard({ entry }: { entry: SubagentEntry }) {
  const { t } = useTranslation('chat');
  const seconds = entry.durationMs === undefined ? undefined : Math.round(entry.durationMs / 1000);
  return (
    <div className="border-border border-l-info-indicator bg-fill my-2 rounded-lg border border-l-4 px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge variant={entry.isError ? 'destructive' : entry.done ? 'success' : 'info'}>
          {t('prompts.subagent', { type: entry.agentType })}
        </Badge>
        <Txt tone="muted" variant="meta">
          {lastSegment(entry.modelId)}
        </Txt>
        {seconds !== undefined && (
          <Txt tone="muted" variant="meta">
            {t('prompts.subagentDuration', { seconds })}
          </Txt>
        )}
      </div>
      <FoldableText text={entry.task} lines={3} tone="muted" />
      {entry.result && (
        <div className="border-border mt-1 border-t pt-1">
          <Txt variant="meta" tone={entry.isError ? undefined : 'muted'}>
            {entry.isError ? t('prompts.subagentFailed') : t('prompts.subagentResult')}
          </Txt>
          <FoldableText text={entry.result} lines={6} />
        </div>
      )}
    </div>
  );
}
