import { useMemo } from 'react';
import { parseSystemReminder } from './system-reminder-utils';
import { SignalActivity } from '@/ds/components/ai/activity';
import { libText } from '@/lib/lib-text';

export interface SystemReminderBadgeProps {
  text: string;
}

export const SystemReminderBadge = ({ text }: SystemReminderBadgeProps) => {
  const reminder = useMemo(() => parseSystemReminder(text), [text]);

  if (!reminder) {
    return text;
  }

  return (
    <SignalActivity
      kind="reminder"
      label={libText('System reminder')}
      detail={reminder.path || reminder.type}
      message={reminder.body}
    />
  );
};
