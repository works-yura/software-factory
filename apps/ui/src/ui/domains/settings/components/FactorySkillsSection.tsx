import { Badge } from '@mastra/playground-ui/components/Badge';
import { Code } from '@mastra/playground-ui/components/Code';
import { Button } from '@mastra/playground-ui/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { DisclosureChevron } from '@mastra/playground-ui/components/DisclosureChevron';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ScrollArea, ScrollAreaViewport } from '@mastra/playground-ui/components/ScrollArea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Code as CodeIcon, FileText, Pencil } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useFactorySkillsQuery } from '../../../../hooks/useFactorySkills';
import type { FactorySkillInfo, InstalledBoardInfo } from '../../../../api/types';
import { orderedBoards } from '../../factory/boardCatalog';
import { boardTitle } from '../../../i18n/boardLabels';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { FactorySkillEditorDialog } from './FactorySkillEditorDialog';
import { SettingsSubsection } from './SettingsSubsection';
import { translator } from '../../../i18n/t';

/** Which Factory's copy of each skill the cards edit, and whether the viewer may. */
const SkillEditingContext = createContext<{ factoryId?: string; canEdit: boolean }>({ canEdit: false });

interface DisplayedSkill {
  name: string;
  readonly title: string;
}

const tk = translator('settings');

/** A built-in skill whose title is translated when read. */
function displayedSkill(name: string, title: () => string): DisplayedSkill {
  return {
    name,
    get title() {
      return title();
    },
  };
}

const BUILT_IN_BOARD_SKILLS: Record<'work', DisplayedSkill[]> = {
  work: [
    displayedSkill('factory-triage', () => tk('skills.names.triage')),
    displayedSkill('factory-plan', () => tk('skills.names.plan')),
    // Work's PR review runs these on a pull request's own card.
    displayedSkill('factory-review', () => tk('skills.names.review')),
    displayedSkill('factory-rereview', () => tk('skills.names.rereview')),
  ],
};

const DISPLAYED_SKILLS: DisplayedSkill[] = [...BUILT_IN_BOARD_SKILLS.work];

function isBuiltInBoard(id: string): id is 'work' {
  return id === 'work';
}

function SkillContent({ content }: { content: string }) {
  const { t } = useTranslation('settings');
  const [raw, setRaw] = useState(false);

  return (
    <div className="group/content relative">
      <ScrollArea maxHeight="24rem" revealScrollbarOnHover={false}>
        <ScrollAreaViewport className="px-4 pb-4">
          {raw ? (
            <Code className="text-caption text-muted-foreground m-0 font-mono whitespace-pre-wrap" code={content} />
          ) : (
            <MarkdownRenderer className="text-muted-foreground text-caption">{content}</MarkdownRenderer>
          )}
        </ScrollAreaViewport>
      </ScrollArea>
      <Button
        size="icon-sm"
        tooltip={raw ? t('skills.showFormatted') : t('skills.showRaw')}
        onClick={() => setRaw(shown => !shown)}
        className="absolute top-1 right-4 opacity-0 transition-opacity group-hover/content:opacity-100 focus-visible:opacity-100"
      >
        {raw ? <FileText /> : <CodeIcon />}
      </Button>
    </div>
  );
}

function SkillCard({ title, skill }: { title: string; skill: FactorySkillInfo }) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const { factoryId, canEdit } = useContext(SkillEditingContext);
  const editable = factoryId !== undefined && canEdit;
  return (
    <SettingsContainer>
      <Collapsible>
        <div className="flex items-center gap-2 pr-4">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <Txt tone="ink" as="span" variant="body">
                {title}
                <Txt font="mono" tone="muted" as="span" variant="caption" className="ml-2">
                  {skill.name}
                </Txt>
              </Txt>
              {skill.error && <Badge variant="destructive">{t('skills.failedBadge')}</Badge>}
              {skill.builtIn && skill.origin !== undefined && skill.origin !== 'bundled' && (
                <Badge>{t('skills.overriddenBadge')}</Badge>
              )}
              {skill.edited && <Badge>{t('skills.editedBadge')}</Badge>}
            </span>
            {skill.error ? (
              <Txt as="span" variant="caption" className="text-destructive-foreground whitespace-pre-wrap">
                {t('skills.cannotLoad', { error: skill.error })}
              </Txt>
            ) : (
              <Txt tone="muted" as="span" variant="caption">
                {skill.description}
              </Txt>
            )}
          </div>
          <DisclosureChevron direction="right" className="text-muted-foreground size-4" />
        </CollapsibleTrigger>
          <Button
            size="sm"
            icon={editable ? <Pencil /> : <FileText />}
            aria-label={t(editable ? 'skills.editAria' : 'skills.viewAria', { name: skill.name })}
            onClick={() => setEditing(true)}
          >
            {t(editable ? 'skills.edit' : 'skills.view')}
          </Button>
        </div>
        <CollapsibleContent>
          <SkillContent content={skill.content} />
        </CollapsibleContent>
      </Collapsible>
      {editing && (
        <FactorySkillEditorDialog
          skill={skill}
          factoryId={factoryId}
          canEdit={canEdit}
          onClose={() => setEditing(false)}
        />
      )}
    </SettingsContainer>
  );
}

function SkillCards({ displayed, skills }: { displayed: DisplayedSkill[]; skills: FactorySkillInfo[] }) {
  return (
    <div className="flex flex-col gap-3">
      {displayed.flatMap(({ name, title }) => {
        const skill = skills.find(s => s.name === name);
        return skill ? [<SkillCard key={name} title={title} skill={skill} />] : [];
      })}
    </div>
  );
}

/** A phase's skill while the skills catalog is loading or failed to load: we cannot tell whether it exists. */
function UncheckedSkillCard({ title, name }: { title: string; name: string }) {
  return (
    <SettingsContainer>
      <div className="px-4 py-3">
        <Txt tone="ink" as="span" variant="body">
          {title}
          <Txt font="mono" tone="muted" as="span" variant="caption" className="ml-2">
            {name}
          </Txt>
        </Txt>
      </div>
    </SettingsContainer>
  );
}

function MissingSkillCard({ title, name }: { title: string; name: string }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsContainer>
      <div className="flex flex-col gap-0.5 px-4 py-3">
        <span className="flex items-center gap-2">
          <Txt tone="ink" as="span" variant="body">
            {title}
            <Txt font="mono" tone="muted" as="span" variant="caption" className="ml-2">
              {name}
            </Txt>
          </Txt>
          <Badge variant="destructive">{t('skills.notFoundBadge')}</Badge>
        </span>
        <Txt as="span" variant="caption" className="text-destructive-foreground">
          {t('skills.notFoundNote', { name })}
        </Txt>
      </div>
    </SettingsContainer>
  );
}

function CustomBoardPhases({
  board,
  skills,
  skillsLoaded,
}: {
  board: InstalledBoardInfo;
  skills: FactorySkillInfo[];
  skillsLoaded: boolean;
}) {
  const { t } = useTranslation('settings');
  const working = board.phases.filter(phase => phase.kind === 'working');
  const withSkill = working.flatMap(phase => (phase.skill ? [{ ...phase, skill: phase.skill }] : []));
  const roles = [
    ...new Set(
      working.flatMap(phase => {
        const role = phase.context ?? phase.role;
        return !phase.skill && role ? [role] : [];
      }),
    ),
  ];
  return (
    <div className="flex flex-col gap-3">
      {withSkill.map(phase => {
        const title = phase.name ?? phase.title;
        const skill = skills.find(s => s.name === phase.skill);
        if (skill) return <SkillCard key={phase.id} title={title} skill={skill} />;
        if (!skillsLoaded) return <UncheckedSkillCard key={phase.id} title={title} name={phase.skill} />;
        return <MissingSkillCard key={phase.id} title={title} name={phase.skill} />;
      })}
      {(withSkill.length === 0 || roles.length > 0) && (
        <SettingsContainer>
          <div className="flex flex-col gap-2 px-4 py-3">
            {roles.length === 0 ? (
              <Txt tone="muted" as="p" variant="caption">
                {t('skills.noRoles')}
              </Txt>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {roles.map(role => (
                  <li key={role}>
                    <Txt font="mono" tone="muted" as="span" variant="caption">
                      {role}
                    </Txt>
                  </li>
                ))}
              </ul>
            )}
            {roles.length > 0 && (
              <Txt tone="muted" as="p" variant="caption">
                {t('skills.kickoffNote')}
              </Txt>
            )}
          </div>
        </SettingsContainer>
      )}
    </div>
  );
}

function BoardGroup({
  board,
  skills,
  skillsLoaded,
}: {
  board: InstalledBoardInfo;
  skills: FactorySkillInfo[];
  skillsLoaded: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <section aria-label={t('skills.boardAria', { title: boardTitle(board.id, board.title) })} className="flex flex-col gap-2">
      <Txt tone="ink" as="h4" variant="body" className="m-0">
        {boardTitle(board.id, board.title)}
      </Txt>
      {isBuiltInBoard(board.id) ? (
        <SkillCards displayed={BUILT_IN_BOARD_SKILLS[board.id]} skills={skills} />
      ) : (
        <CustomBoardPhases board={board} skills={skills} skillsLoaded={skillsLoaded} />
      )}
    </section>
  );
}

/** App skills no board phase runs; agents can still load them, and users can invoke them. */
function OtherAppSkills({ skills, boards }: { skills: FactorySkillInfo[]; boards: InstalledBoardInfo[] }) {
  const { t } = useTranslation('settings');
  const used = new Set(boards.flatMap(board => board.phases.flatMap(phase => (phase.skill ? [phase.skill] : []))));
  const other = skills.filter(skill => skill.builtIn === false && !used.has(skill.name));
  if (other.length === 0) return null;
  return (
    <section aria-label={t('skills.appSkills')} className="flex flex-col gap-2">
      <Txt tone="ink" as="h4" variant="body" className="m-0">
        {t('skills.appSkills')}
      </Txt>
      <div className="flex flex-col gap-3">
        {other.map(skill => (
          <SkillCard key={skill.name} title={skill.name} skill={skill} />
        ))}
      </div>
    </section>
  );
}

export function FactorySkillsSection({ factoryId }: { factoryId?: string }) {
  const { t } = useTranslation('settings');
  const skillsQuery = useFactorySkillsQuery(factoryId);
  const catalog = useBoardCatalog(factoryId);
  const skills = skillsQuery.data?.skills ?? [];
  const canEdit = skillsQuery.data?.canEdit ?? false;
  const boards = catalog.data === undefined ? undefined : orderedBoards(catalog.data);

  return (
    <SkillEditingContext.Provider value={{ factoryId, canEdit }}>
    <SettingsSubsection
      scope="factory"
      title={t('skills.title')}
      description={t('skills.description')}
    >
      {skillsQuery.isPending && (
        <Txt tone="muted" as="p" variant="caption" role="status">
          {t('skills.loading')}
        </Txt>
      )}
      {skillsQuery.error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {skillsQuery.error instanceof Error ? skillsQuery.error.message : t('skills.loadFailed')}
        </Txt>
      )}
      {catalog.error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {t('skills.boardsLoadFailed')}
        </Txt>
      )}
      {boards === undefined ? (
        <SkillCards displayed={DISPLAYED_SKILLS} skills={skills} />
      ) : boards.length === 0 ? (
        <div className="flex flex-col gap-5">
          <Txt tone="muted" as="p" variant="caption">
            {t('skills.noBoards')}
          </Txt>
          <OtherAppSkills skills={skills} boards={boards} />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {boards.map(board => (
            <BoardGroup key={board.id} board={board} skills={skills} skillsLoaded={skillsQuery.isSuccess} />
          ))}
          <OtherAppSkills skills={skills} boards={boards} />
        </div>
      )}
    </SettingsSubsection>
    </SkillEditingContext.Provider>
  );
}
