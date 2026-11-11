import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Hourglass } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useResumeSessionMutation, useSessionUsageLimit } from '../hooks/useSessionUsageLimit';

/** The countdown moves on every 30 seconds: it shows minutes. */
const TICK_MS = 30_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * A chat session that stopped because every account is out of usage, in place of the run's error:
 * when it resumes on its own, a countdown, and "Resume now" to try at once. Shown only while the
 * session is parked (Claude Code and Codex sessions; a card's run is the dispatcher's).
 */
export function UsageLimitParkBanner() {
  const { t, i18n } = useTranslation('chat');
  const { usageLimit, refetch } = useSessionUsageLimit();
  const resume = useResumeSessionMutation();
  const now = useNow(usageLimit !== null);
  const [stillLimited, setStillLimited] = useState(false);
  const parkedUntil = usageLimit?.parkedUntil;
  const until = parkedUntil ? new Date(parkedUntil) : undefined;
  const leftMs = until ? until.getTime() - now : 0;
  const due = leftMs <= 0;
  useEffect(() => {
    // Due: the server is resuming it; read the state again shortly after.
    if (!parkedUntil || !due) return;
    const timer = setTimeout(() => void refetch(), 45_000);
    return () => clearTimeout(timer);
  }, [due, parkedUntil, refetch]);
  if (!usageLimit || !until || Number.isNaN(until.getTime())) return null;

  const time = new Intl.DateTimeFormat(i18n.language, {
    ...(sameDay(until, new Date(now)) ? {} : { weekday: 'short' as const }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(until);
  const totalMinutes = Math.max(1, Math.ceil(leftMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const duration =
    hours > 0
      ? minutes > 0
        ? t('usageLimitPark.hoursMinutes', { hours, minutes })
        : t('usageLimitPark.hours', { hours })
      : t('usageLimitPark.minutes', { minutes: totalMinutes });

  const onResume = () => {
    setStillLimited(false);
    resume.mutate(undefined, {
      onSuccess: result => setStillLimited(result.action === 'parked'),
    });
  };

  return (
    <Notice
      variant="warning"
      role="status"
      icon={<Hourglass aria-hidden="true" />}
      className="mb-2"
      title={t('usageLimitPark.title', { time })}
      action={
        <Button variant="ghost" size="sm" onClick={onResume} disabled={resume.isPending}>
          {resume.isPending ? t('usageLimitPark.resuming') : t('usageLimitPark.resumeNow')}
        </Button>
      }
    >
      <Notice.Message>
        {due ? t('usageLimitPark.resumingSoon') : t('usageLimitPark.countdown', { duration })}
        {stillLimited && ` ${t('usageLimitPark.stillLimited')}`}
        {resume.isError && ` ${t('usageLimitPark.resumeFailed')}`}
      </Notice.Message>
    </Notice>
  );
}
