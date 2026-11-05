import type { LucideIcon } from 'lucide-react';
import { Bot, Inbox, PackageCheck } from 'lucide-react';

import { translator } from '../../../../i18n/t';
import type { RunsState } from '../../hooks/useFactoryActivity';
import { ACTIVITY_KIND_ORDER } from '../../periodActivity';
import type { ActivityCounts, ActivityKind, ActivitySlot } from '../../periodActivity';

const tk = translator('chat');

const LOOKS: Record<ActivityKind, { icon: LucideIcon; tone: string }> = {
  cameIn: { icon: Inbox, tone: 'opacity-20' },
  ran: { icon: Bot, tone: 'opacity-40' },
  shipped: { icon: PackageCheck, tone: 'opacity-70' },
};

/** Each kind's look; its label is translated when read. */
export const ACTIVITY_KINDS = ACTIVITY_KIND_ORDER.map(kind => ({
  kind,
  ...LOOKS[kind],
  get label() {
    return tk(`activity.kind.${kind}.label`);
  },
}));

function counted(kind: ActivityKind, count: number): string {
  return tk(`activity.kind.${kind}.counted`, { count });
}
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export function slotWhen(slot: ActivitySlot, hoursPerSlot: number) {
  const day = dayFormat.format(slot.start);
  if (hoursPerSlot >= 24) return { day };
  return { day, hours: `${hourFormat.format(slot.start)} – ${hourFormat.format(slot.end)}` };
}

export function totalOf(kind: ActivityKind, counts: ActivityCounts, runs: RunsState) {
  const value = counts[kind];
  const many = counted(kind, 2);
  if (kind === 'ran' && runs.status === 'pending') {
    return { count: '…', noun: many, label: tk('activity.loading', { noun: many }) };
  }
  const known = kind !== 'ran' || (runs.status === 'success' && (runs.complete || value > 0));
  if (!known) return { count: '–', noun: many, label: tk('activity.unavailable', { noun: many }) };
  const atLeast = kind === 'ran' && !runs.complete;
  const count = `${value.toLocaleString()}${atLeast ? '+' : ''}`;
  const noun = atLeast ? many : counted(kind, value);
  return { count, noun, label: `${count} ${noun}` };
}

export function countsLabel(counts: ActivityCounts, runs: RunsState): string {
  return ACTIVITY_KIND_ORDER.map(kind => totalOf(kind, counts, runs).label).join(', ');
}
