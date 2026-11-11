import type { SkillActivation } from './skill-activation';
import { agentGlyph } from '@/ds/components/AgentIndicator';
import { ActivityItem, SignalActivity } from '@/ds/components/ai/activity';
import type { ActivityAppearance } from '@/ds/components/ai/activity';
import { MarkdownRenderer } from '@/ds/components/MarkdownRenderer';
import { ScrollArea } from '@/ds/components/ScrollArea';
import { libText } from '@/lib/lib-text';

const SkillGlyph = agentGlyph('skill');

export function SkillMessage({
  activation,
  defaultOpen,
  appearance = 'row',
}: {
  activation: SkillActivation;
  defaultOpen?: boolean;
  appearance?: ActivityAppearance;
}) {
  const { name, arguments: args, instructions, description, feed } = activation;
  const item = (
    <ActivityItem
      appearance={appearance}
      label={libText('Skill')}
      detail={args ? `${name} ${args}` : name}
      icon={<SkillGlyph className={appearance === 'inline' ? undefined : 'text-span-skill'} aria-hidden />}
      data-skill-name={name}
      aria-label={`Skill: ${name}`}
    >
      <ScrollArea maxHeight="24rem" revealScrollbarOnHover={false}>
        <MarkdownRenderer className="text-caption">{instructions}</MarkdownRenderer>
      </ScrollArea>
    </ActivityItem>
  );

  if (description === undefined && feed === undefined) return item;

  return (
    <div className="flex flex-col">
      {item}
      {description !== undefined && (
        <SignalActivity
          kind="reactive"
          label={libText('Work item description')}
          message={description}
          appearance={appearance}
        />
      )}
      {feed !== undefined && (
        <SignalActivity kind="reactive" label={libText('Work item feed')} message={feed} appearance={appearance} />
      )}
    </div>
  );
}
