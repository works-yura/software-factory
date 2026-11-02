import type { AgentControllerSessionSettings, ToolCategory } from '@mastra/client-js';
import {
  getAvailableThinkingLevelsForModel,
  parseThinkCommand,
  runThinkingLevel,
  THINK_COMMAND_DESCRIPTOR,
} from '@mastra/code-sdk/thinking';
import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import { useLocation, useNavigate, useParams } from 'react-router';

import { translator } from '../../../i18n/t';

import {
  useClearAgentControllerGoalMutation,
  usePauseAgentControllerGoalMutation,
  useResumeAgentControllerGoalMutation,
  useSetAgentControllerGoalMutation,
} from '../../../../hooks/useAgentControllerGoalMutations';
import {
  useAbortAgentControllerMutation,
  useFollowUpAgentControllerMutation,
} from '../../../../hooks/useAgentControllerRunMutations';
import { useAgentControllerSettings } from '../../../../hooks/useAgentControllerSettings';
import { useFactoryThinkingDefaultQuery } from '../../../../hooks/use-thinking';
import { useModelReasoningOptions } from '../../../../hooks/useAvailableModels';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useUpdateAgentControllerSettingsMutation } from '../../../../hooks/useUpdateAgentControllerSettingsMutation';
import { MODEL_DEFAULTS_ANCHORS, settingsSectionPath } from '../../settings/settingsSections';
import type { SlashCommand, SlashCommandOption } from '../services/commands';
import { findCommand, parseSlashCommand } from '../services/commands';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { factoryThinkingSourceLabel, THINKING_LEVEL_LABELS } from '../services/thinkingLevels';
import { useChatModels } from './useChatModels';
import { useChatModelCatalog } from './useChatModelCatalog';
import { useChatPermissions } from './useChatPermissions';
import { useChatSessionContext } from './useChatSessionContext';
import type { HarnessDescriptor } from '@factory/contracts';
import { useChatRuntime } from './useChatRuntime';
import { useChatTranscript } from './useChatTranscript';

const tk = translator('chat');

const TOOL_CATEGORIES: ToolCategory[] = ['read', 'edit', 'execute', 'mcp', 'other'];

function describeFactoryDefault(level: string): string {
  return `${level} (${factoryThinkingSourceLabel()})`;
}

export function useChatCommandRegistry(prefillComposer: (draft: string) => void) {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId, sessionEnabled, baseUrl, modelLockedReason, harness } = useChatSessionContext();
  const { transcript, busy, localUser, pushNotice } = useChatTranscript();
  const { usage, omPhase } = useChatRuntime();
  const { activeModelId, setModel } = useChatModels();
  const { catalogTarget } = useChatModelCatalog();
  const activeModelReasoningOptions = useModelReasoningOptions(activeModelId, catalogTarget);
  const availableThinkingLevels = getAvailableThinkingLevelsForModel(activeModelId ?? '', activeModelReasoningOptions);

  const hookArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  };
  const clearGoalMutation = useClearAgentControllerGoalMutation(hookArgs);
  const pauseGoalMutation = usePauseAgentControllerGoalMutation(hookArgs);
  const resumeGoalMutation = useResumeAgentControllerGoalMutation(hookArgs);
  const setGoalMutation = useSetAgentControllerGoalMutation(hookArgs);
  const abortMutation = useAbortAgentControllerMutation(hookArgs);
  const followUpMutation = useFollowUpAgentControllerMutation(hookArgs);
  const settingsQuery = useAgentControllerSettings(hookArgs);
  const factoryThinkingQuery = useFactoryThinkingDefaultQuery(factoryId, { enabled: false });
  const updateSettingsMutation = useUpdateAgentControllerSettingsMutation(hookArgs);
  const { permissions, permissionsLoading, setPermissionForCategory } = useChatPermissions();

  const openSessionDefaults = () => {
    if (factoryId)
      void navigate(settingsSectionPath(factoryId, 'models', MODEL_DEFAULTS_ANCHORS.factory), {
        state: { from: location },
      });
  };

  const currentThinkingLevel = settingsQuery.data?.thinkingLevel;
  const runningThinkingLevel =
    currentThinkingLevel && runThinkingLevel(activeModelId ?? '', currentThinkingLevel, activeModelReasoningOptions);
  const thinkingLevelOptions: SlashCommandOption[] = [
    {
      value: 'default',
      label: tk('common.default'),
      description: tk('commands.factoryDefault'),
      active: settingsQuery.data !== undefined && currentThinkingLevel === undefined,
    },
    ...availableThinkingLevels.map(level => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
      active: runningThinkingLevel === level,
    })),
  ];

  const ensureSettings = async (): Promise<AgentControllerSessionSettings> => {
    if (settingsQuery.data) return settingsQuery.data;
    const result = await settingsQuery.refetch();
    if (!result.data) throw new Error(tk('commands.settingsUnavailable'));
    return result.data;
  };
  const ensureFactoryThinkingDefault = async (): Promise<ThinkingLevelSetting> => {
    if (factoryThinkingQuery.data) return factoryThinkingQuery.data;
    const result = await factoryThinkingQuery.refetch();
    if (!result.data) throw new Error(tk('commands.factoryThinkingUnavailable'));
    return result.data;
  };

  const everyCommand: SlashCommand[] = [
    {
      name: 'model',
      args: '<id>',
      description: tk('commands.model'),
      requiresSession: true,
      execute: async rawArguments => {
        if (!rawArguments) return;
        if (modelLockedReason) return pushNotice(modelLockedReason);
        await setModel(rawArguments);
      },
    },
    {
      name: 'goal',
      args: '<objective>',
      description: tk('commands.goal'),
      requiresSession: true,
      execute: async rawArguments => {
        if (rawArguments) await setGoalMutation.mutateAsync(rawArguments);
      },
    },
    {
      name: 'goal-clear',
      description: tk('commands.goalClear'),
      requiresSession: true,
      execute: async () => {
        await clearGoalMutation.mutateAsync();
      },
    },
    {
      name: 'goal-pause',
      description: tk('commands.goalPause'),
      requiresSession: true,
      execute: async () => {
        await pauseGoalMutation.mutateAsync();
      },
    },
    {
      name: 'goal-resume',
      description: tk('commands.goalResume'),
      requiresSession: true,
      execute: async () => {
        await resumeGoalMutation.mutateAsync();
      },
    },
    {
      name: 'permissions',
      description: tk('commands.permissions'),
      requiresSession: true,
      execute: async () => {
        if (permissionsLoading) return;
        const rules = permissions ?? { categories: {}, tools: {} };
        const categories =
          Object.entries(rules.categories ?? {})
            .map(([key, value]) => `  ${key}: ${value}`)
            .join('\n') || `  ${tk('common.none')}`;
        const tools =
          Object.entries(rules.tools ?? {})
            .map(([key, value]) => `  ${key}: ${value}`)
            .join('\n') || `  ${tk('common.none')}`;
        pushNotice(tk('commands.permissionsNotice', { categories, tools }));
      },
    },
    {
      name: 'yolo',
      description: tk('commands.yolo'),
      requiresSession: true,
      execute: async () => {
        for (const category of TOOL_CATEGORIES) {
          await setPermissionForCategory(category, 'allow');
        }
        pushNotice(tk('commands.yoloNotice'));
      },
    },
    {
      name: 'cost',
      description: tk('commands.cost'),
      requiresSession: false,
      execute: async () => {
        pushNotice(
          !usage?.totalTokens
            ? tk('commands.noUsage')
            : tk('commands.usage', {
                prompt: usage.promptTokens ?? 0,
                completion: usage.completionTokens ?? 0,
                total: usage.totalTokens,
              }),
        );
      },
    },
    {
      ...THINK_COMMAND_DESCRIPTOR,
      description: tk('commands.think'),
      requiresSession: true,
      options: thinkingLevelOptions,
      execute: async (rawArguments, originalText) => {
        const action = parseThinkCommand(rawArguments, availableThinkingLevels);
        try {
          if (action.kind === 'invalid') {
            prefillComposer(originalText);
            pushNotice(
              tk('commands.unknownThinkingLevel', { value: action.value, levels: action.levels.join(', ') }),
              'error',
            );
            return;
          }
          const changesThinkingLevel = action.kind === 'set' || action.kind === 'clear';
          if (modelLockedReason && changesThinkingLevel) return pushNotice(modelLockedReason);
          if (action.kind === 'set') {
            await ensureSettings();
            await updateSettingsMutation.mutateAsync({ thinkingLevel: action.level });
            pushNotice(tk('commands.thinkingLevelSet', { level: action.level }));
            return;
          }
          if (action.kind === 'clear') {
            await ensureSettings();
            await updateSettingsMutation.mutateAsync({ thinkingLevel: null });
            try {
              const factoryDefault = await ensureFactoryThinkingDefault();
              pushNotice(tk('commands.thinkingLevelDefault', { level: describeFactoryDefault(factoryDefault) }));
            } catch {
              pushNotice(tk('commands.thinkingLevelDefaultUnknown'));
            }
            return;
          }
          const [settings, factoryDefault] = await Promise.all([ensureSettings(), ensureFactoryThinkingDefault()]);
          const defaultLevel = describeFactoryDefault(factoryDefault);
          pushNotice(
            settings.thinkingLevel
              ? tk('commands.thinkingLevelOverride', { level: settings.thinkingLevel, defaultLevel })
              : tk('commands.thinkingLevel', { level: defaultLevel }),
          );
        } catch (error) {
          prefillComposer(originalText);
          throw error;
        }
      },
    },
    {
      name: 'om',
      description: tk('commands.om'),
      requiresSession: false,
      execute: async () => pushNotice(tk('commands.omNotice', { phase: omPhase })),
    },
    {
      name: 'settings',
      description: tk('commands.settings'),
      requiresSession: false,
      execute: async () => {
        pushNotice(
          tk('commands.settingsNotice', {
            factory: factoryQuery.data?.name ?? tk('common.none'),
            session: sessionId || '—',
            model: activeModelId ?? '—',
            thread: transcript.threadId ?? '—',
            running: String(busy),
          }),
        );
      },
    },
    {
      name: 'connect',
      description: tk('commands.connect'),
      requiresSession: false,
      execute: async () => openSessionDefaults(),
    },
    {
      name: 'login',
      description: tk('commands.login'),
      requiresSession: false,
      execute: async () => openSessionDefaults(),
    },
    {
      name: 'follow-up',
      args: '<message>',
      description: tk('commands.followUp'),
      requiresSession: true,
      execute: async rawArguments => {
        if (rawArguments) {
          localUser(rawArguments);
          await followUpMutation.mutateAsync(rawArguments);
        }
      },
    },
    {
      name: 'abort',
      description: tk('commands.abort'),
      requiresSession: true,
      execute: async () => {
        await abortMutation.mutateAsync();
      },
    },
  ];

  // Commands for what this session's harness does not have stay out of the list and of /help.
  const unsupported = unsupportedCommands(harness);
  const commandsWithoutHelp = everyCommand.filter(command => !unsupported.has(command.name));

  const helpCommand: SlashCommand = {
    name: 'help',
    description: tk('commands.help'),
    requiresSession: false,
    execute: async () => {
      const commands = [...commandsWithoutHelp, helpCommand];
      const width = Math.max(...commands.map(command => `/${command.name} ${command.args ?? ''}`.length));
      const lines = commands.map(command => {
        const signature = `/${command.name} ${command.args ?? ''}`.padEnd(width);
        return `  ${signature}  — ${command.description}`;
      });
      pushNotice([tk('commands.available'), ...lines].join('\n'));
    },
  };

  const commands = [...commandsWithoutHelp, helpCommand];

  const runComposerCommand = async (text: string): Promise<boolean> => {
    if (!text.startsWith('/')) return false;
    const command = findCommand(commands, text);
    const parsed = parseSlashCommand(text);
    if (!command) {
      prefillComposer(text);
      pushNotice(tk('commands.unknown', { name: parsed.name ?? '' }), 'error');
      return true;
    }
    await command.execute(parsed.rawArguments, text);
    return true;
  };

  return { commands, runComposerCommand };
}

/** Slash commands the harness has no counterpart for; an unknown harness (still loading) keeps them all. */
export function unsupportedCommands(harness: HarnessDescriptor | undefined): Set<string> {
  if (!harness) return new Set();
  const names: string[] = [];
  if (harness.modelScope !== 'session') names.push('model');
  if (!harness.supports.goal) names.push('goal', 'goal-clear', 'goal-pause', 'goal-resume');
  if (!harness.supports.sessionPermissions) names.push('permissions', 'yolo');
  if (!harness.supports.thinkingLevel) names.push(THINK_COMMAND_DESCRIPTOR.name);
  if (!harness.supports.memory) names.push('om');
  return new Set(names);
}
