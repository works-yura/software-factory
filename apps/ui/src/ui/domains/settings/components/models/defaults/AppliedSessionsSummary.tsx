import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

function skippedReasonSummary(reasons: Array<{ reason: string }>) {
  const counts = new Map<string, number>();
  for (const { reason } of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${reason.replaceAll('-', ' ')} (${count})`).join(', ');
}

export function AppliedSessionsSummary({
  result,
}: {
  result: { applied: string[]; skipped: Array<{ reason: string }> };
}) {
  const { t } = useTranslation('settings');
  const switched = result.applied.length;
  return (
    <Txt variant="meta">
      {switched === 0
        ? t('models.factoryDefault.nothingToSwitch')
        : t('models.factoryDefault.switched', { count: switched })}
      {result.skipped.length > 0 &&
        t('models.factoryDefault.skipped', {
          count: result.skipped.length,
          reasons: skippedReasonSummary(result.skipped),
        })}
    </Txt>
  );
}
