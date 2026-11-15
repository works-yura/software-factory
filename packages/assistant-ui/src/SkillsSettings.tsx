import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SkillSimpleForm } from '@mastra/playground-ui/domains/skills/skill-simple-form';
import { SettingsContainer, SettingsEmptyRow, SettingsItem, SettingsListHeader } from '@mastra/playground-ui/new/settings';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantSettings, useSettingsActions } from './api';
import { useAssistantSkill, useAssistantSkills, useSkillActions } from './settings-api';
import type { AssistantSkillEntry } from './settings-api';

const MAX_PICKED = 10;

/**
 * One skill in Factory's skill editor (the kit's SkillSimpleForm): saving keeps the person's text for
 * their assistant only — a catalogue skill's original and every Factory's edits stay as they are.
 * An overridden skill can go back to its original; a skill of their own can be deleted. With no
 * name, it creates a skill of their own.
 */
export function AssistantSkillEditorDialog({ name, onClose }: { name?: string; onClose: () => void }) {
  const { t } = useTranslation('assistant');
  const skill = useAssistantSkill(name);
  const actions = useSkillActions();
  const creating = name === undefined;
  const [newName, setNewName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (skill.data) {
      setDescription(skill.data.description);
      setInstructions(skill.data.instructions);
    }
  }, [skill.data]);

  const data = skill.data;
  const changed = creating ? Boolean(newName && description && instructions) : data !== undefined && (description !== data.description || instructions !== data.instructions);
  const pending = actions.save.isPending || actions.create.isPending || actions.remove.isPending;
  const error = actions.save.error ?? actions.create.error ?? actions.remove.error;
  const close = { onSuccess: onClose };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="xl" aria-label={creating ? t('skills.newTitle') : t('skills.editTitle', { name })}>
        <DialogHeader>
          <DialogTitle>{creating ? t('skills.newTitle') : t('skills.editTitle', { name })}</DialogTitle>
          <DialogDescription>{creating ? t('skills.newDescription') : t('skills.editDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex h-[60vh] flex-col gap-3">
            {skill.isError ? <Notice variant="destructive">{skill.error.message}</Notice> : null}
            {data?.overridden ? (
              <Txt as="p" variant="caption" tone="muted" role="note">
                {t('skills.overriddenNote')}
              </Txt>
            ) : null}
            {creating || data ? (
              <SkillSimpleForm
                name={creating ? newName : (name ?? '')}
                onNameChange={setNewName}
                nameReadOnly={!creating}
                description={description}
                onDescriptionChange={setDescription}
                instructions={instructions}
                onInstructionsChange={setInstructions}
              />
            ) : (
              <Skeleton className="h-full w-full" />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {error ? (
            <Txt as="span" variant="caption" role="alert" className="text-destructive-foreground mr-auto">
              {error.message}
            </Txt>
          ) : null}
          <DialogCancel>{t('actions.cancel')}</DialogCancel>
          {data?.overridden ? (
            <Button disabled={pending} onClick={() => actions.remove.mutate(data.name, close)}>
              {t('skills.revert')}
            </Button>
          ) : null}
          {data?.origin === 'personal' ? (
            <Button variant="destructive-ghost" disabled={pending} onClick={() => actions.remove.mutate(data.name, close)}>
              {t('skills.delete')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!changed || pending}
            onClick={() =>
              creating
                ? actions.create.mutate({ name: newName.trim(), description, instructions }, close)
                : actions.save.mutate({ name: name!, description, instructions }, close)
            }
          >
            {creating ? t('skills.create') : t('skills.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillRow({ skill, onOpen, onToggle, disabled }: { skill: AssistantSkillEntry; onOpen: () => void; onToggle: (on: boolean) => void; disabled: boolean }) {
  const { t } = useTranslation('assistant');
  return (
    <SettingsItem
      data-testid={`assistant-skill-${skill.name}`}
      title={
        <span className="flex items-center gap-2">
          {skill.name}
          <Badge size="xs" variant="neutral">
            {skill.origin === 'personal' ? t('skills.mine') : t('skills.factory')}
          </Badge>
          {skill.overridden ? (
            <Badge size="xs" variant="warning">
              {t('skills.changed')}
            </Badge>
          ) : null}
        </span>
      }
      description={skill.description}
    >
      <Button size="sm" variant="ghost" onClick={onOpen}>
        {t('skills.open')}
      </Button>
      <Switch
        checked={skill.enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={t('skills.toggle', { name: skill.name })}
      />
    </SettingsItem>
  );
}

/**
 * Settings › «Помічник» › Навички: every skill the agent can be given — Factory's catalogue (as
 * shipped, or as the person changed it for their assistant only) and their own — each with a
 * switch, its full text a click away.
 */
export function AssistantSkillsSettings() {
  const { t } = useTranslation('assistant');
  const skills = useAssistantSkills();
  const settings = useAssistantSettings();
  const save = useSettingsActions().save;
  const [open, setOpen] = useState<{ name?: string } | null>(null);
  const picked = skills.data?.filter(skill => skill.enabled).map(skill => skill.name) ?? [];
  const toggle = (name: string, on: boolean) => save.mutate({ skills: on ? [...picked, name] : picked.filter(skill => skill !== name) });
  const action = (
    <Button size="sm" icon={<Plus />} onClick={() => setOpen({})}>
      {t('skills.new')}
    </Button>
  );

  return (
    <SettingsContainer>
      {skills.isError ? <Notice variant="destructive">{skills.error.message}</Notice> : null}
      {!skills.data ? (
        <Skeleton className="h-24 w-full" />
      ) : skills.data.length === 0 ? (
        <SettingsEmptyRow action={action}>{t('skills.empty')}</SettingsEmptyRow>
      ) : (
        <>
          <SettingsListHeader action={action}>{t('skills.count', { count: picked.length, max: MAX_PICKED })}</SettingsListHeader>
          {skills.data.map(skill => (
            <SkillRow
              key={skill.name}
              skill={skill}
              disabled={!settings.data || save.isPending || (!skill.enabled && picked.length >= MAX_PICKED)}
              onOpen={() => setOpen({ name: skill.name })}
              onToggle={on => toggle(skill.name, on)}
            />
          ))}
        </>
      )}
      {save.isError ? <Notice variant="destructive">{save.error.message}</Notice> : null}
      {open ? <AssistantSkillEditorDialog {...(open.name ? { name: open.name } : {})} onClose={() => setOpen(null)} /> : null}
    </SettingsContainer>
  );
}
