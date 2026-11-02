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
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SkillSimpleForm } from '@mastra/playground-ui/domains/skills/skill-simple-form';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '../../../../api/client';
import type { FactorySkillInfo } from '../../../../api/types';
import { useFactorySkillEditMutation } from '../../../../hooks/useFactorySkills';

interface FactorySkillEditorDialogProps {
  skill: FactorySkillInfo;
  /** The Factory project whose copy of the skill is edited; without one the skill is view-only. */
  factoryId?: string;
  canEdit: boolean;
  onClose: () => void;
}

/**
 * Writes the editor's fields back as a SKILL.md. Values are JSON-quoted, which
 * YAML reads as the same strings, so descriptions with `:` or `#` stay intact,
 * and frontmatter fields the editor does not show are kept.
 */
export function composeSkillMarkdown({
  name,
  description,
  frontmatter,
  instructions,
}: {
  name: string;
  description: string;
  frontmatter?: Record<string, unknown>;
  instructions: string;
}): string {
  const fields = [
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...Object.entries(frontmatter ?? {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
  ];
  return `---\n${fields.join('\n')}\n---\n\n${instructions.trim()}\n`;
}

function errorText(error: Error): string {
  return error instanceof ApiRequestError ? (error.detail ?? error.message) : error.message;
}

/**
 * Opens a Factory skill in the shared skill editor. Admins save the edit for this Factory
 * project or revert it to the original; everyone else views it.
 */
export function FactorySkillEditorDialog({ skill, factoryId, canEdit, onClose }: FactorySkillEditorDialogProps) {
  const { t } = useTranslation('settings');
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.content);
  const edit = useFactorySkillEditMutation(factoryId);
  const readOnlyReason = !factoryId ? t('skills.editor.needFactory') : !canEdit ? t('skills.editor.adminsOnly') : undefined;
  const readOnly = readOnlyReason !== undefined;
  const changed = description !== skill.description || instructions !== skill.content;

  const save = () =>
    edit.mutate(
      {
        name: skill.name,
        content: composeSkillMarkdown({ name: skill.name, description, frontmatter: skill.frontmatter, instructions }),
      },
      { onSuccess: onClose },
    );
  const revert = () => edit.mutate({ name: skill.name, content: null }, { onSuccess: onClose });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="xl" aria-label={readOnly ? t('skills.editor.viewTitle') : t('skills.editor.editTitle')}>
        <DialogHeader>
          <DialogTitle>{readOnly ? t('skills.editor.viewTitle') : t('skills.editor.editTitle')}</DialogTitle>
          <DialogDescription>{readOnlyReason ?? t('skills.editor.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex h-[60vh] flex-col gap-3">
            {skill.edited && skill.originalChanged && (
              <Txt as="p" variant="caption" tone="muted" role="note">
                {t('skills.editor.originalChanged')}
              </Txt>
            )}
            <SkillSimpleForm
              name={skill.name}
              onNameChange={() => {}}
              nameReadOnly
              description={description}
              onDescriptionChange={setDescription}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              readOnly={readOnly}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          {edit.error && (
            <Txt
              as="span"
              variant="caption"
              role="alert"
              className="text-destructive-foreground mr-auto whitespace-pre-wrap"
            >
              {errorText(edit.error)}
            </Txt>
          )}
          <DialogCancel>{readOnly ? t('skills.editor.close') : t('skills.editor.cancel')}</DialogCancel>
          {!readOnly && skill.edited && (
            <Button onClick={revert} disabled={edit.isPending}>
              {t('skills.editor.revert')}
            </Button>
          )}
          {!readOnly && (
            <Button variant="primary" onClick={save} disabled={!changed || edit.isPending}>
              {t('skills.editor.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
