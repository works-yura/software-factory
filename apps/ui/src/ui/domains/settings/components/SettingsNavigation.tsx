import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { Sidebar, useSidebar } from '@mastra/playground-ui/components/Sidebar';
import { Txt } from '@mastra/playground-ui/components/Txt';
import {
  ArrowLeft,
  Bot,
  Box,
  Brain,
  Bug,
  Building2,
  ChartColumn,
  CircleUserRound,
  GitBranch,
  Inbox,
  Palette,
  Plug,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useCloseSettings } from '../hooks/useCloseSettings';
import { useFactoryHarness } from './models/harness/HarnessSettings';
import { useSettingsSection } from '../hooks/useSettingsSection';
import { SETTINGS_SECTION_LABELS, settingsSectionPath } from '../settingsSections';
import type { SettingsSection } from '../settingsSections';
import { i18n } from '../../../i18n';
import { useTranslation } from 'react-i18next';

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  searchText: string;
};

type SettingsNavGroup = {
  id: string;
  label: string;
  items: SettingsNavItem[];
};

/**
 * Groups follow where a setting lives on the server, not its topic: the person's own, the
 * organization's (every Factory in it), this Factory's, and the server's. The Factory group is
 * titled with the Factory's name, so it is plain which Factory its pages change.
 */
const SETTINGS_GROUPS: SettingsNavGroup[] = [
  // The person's own: profile, session, appearance.
  {
    id: 'account',
    get label() {
      return i18n.t('groups.account', { ns: 'settings' });
    },
    items: [
      {
        id: 'account',
        get label() {
          return SETTINGS_SECTION_LABELS.account;
        },
        icon: CircleUserRound,
        searchText: 'my account profile identity email authentication session log out sign out user',
      },
      {
        id: 'preferences',
        get label() {
          return SETTINGS_SECTION_LABELS.preferences;
        },
        icon: Palette,
        searchText: 'preferences general theme appearance color scheme completion sound',
      },
    ],
  },
  // Organization-wide, for every Factory: members and connections (org-level).
  {
    id: 'organization',
    get label() {
      return i18n.t('groups.organization', { ns: 'settings' });
    },
    items: [
      {
        id: 'organization',
        get label() {
          return SETTINGS_SECTION_LABELS.organization;
        },
        icon: Users,
        searchText: 'organization team members invite invitation link roles owner admin remove switch organizations',
      },
      {
        id: 'integrations',
        get label() {
          return SETTINGS_SECTION_LABELS.integrations;
        },
        icon: Plug,
        searchText: 'connections integrations services google cloud firebase logs crashes crashlytics database firestore clickup github gitlab mcp servers tools toolbox connectors service account',
      },
    ],
  },
  // This Factory only: stored per Factory project.
  {
    id: 'factory',
    get label() {
      return i18n.t('groups.factory', { ns: 'settings' });
    },
    items: [
      {
        id: 'models',
        get label() {
          return SETTINGS_SECTION_LABELS.models;
        },
        icon: Bot,
        searchText: 'models harness runtime claude code default model factory models routing factory defaults thinking level api keys providers credentials sign in oauth custom endpoints',
      },
      {
        id: 'memory',
        get label() {
          return SETTINGS_SECTION_LABELS.memory;
        },
        icon: Brain,
        searchText: 'memory factory memory shared memory observational recall observer reflector thresholds attachments summarize context',
      },
      {
        id: 'behavior',
        get label() {
          return SETTINGS_SECTION_LABELS.behavior;
        },
        icon: SlidersHorizontal,
        searchText: 'behavior auto approve tools smart editing notifications permissions read edit execute mcp',
      },
      {
        id: 'repositories',
        get label() {
          return SETTINGS_SECTION_LABELS.repositories;
        },
        icon: GitBranch,
        searchText: 'repositories source control git branches remotes code worktrees sandbox setup github',
      },
      {
        id: 'environment',
        get label() {
          return SETTINGS_SECTION_LABELS.environment;
        },
        icon: Box,
        searchText: 'environment sandbox resources cpu memory workdir repositories order setup teardown build triggers',
      },
      {
        id: 'intake',
        get label() {
          return SETTINGS_SECTION_LABELS.intake;
        },
        icon: Inbox,
        searchText: 'work intake sources tasks issues pull requests github feed sync intake routes routing new cards card moves board catch-all',
      },
      {
        id: 'analytics',
        get label() {
          return SETTINGS_SECTION_LABELS.analytics;
        },
        icon: ChartColumn,
        searchText: 'analytics metrics usage tokens cost turns cache completions lead time throughput queue health overview dashboard',
      },
      {
        id: 'factory',
        get label() {
          return SETTINGS_SECTION_LABELS.factory;
        },
        icon: ChartColumn,
        searchText: 'analytics metrics usage tokens cost turns cache completions lead time throughput queue health overview dashboard',
      },
    ],
  },
  // The deployment: the server's installed versions.
  {
    id: 'server',
    get label() {
      return i18n.t('groups.server', { ns: 'settings' });
    },
    items: [
      {
        id: 'debug',
        get label() {
          return SETTINGS_SECTION_LABELS.debug;
        },
        icon: Bug,
        searchText: 'debug versions packages release build node mastra core factory installed running',
      },
    ],
  },
];

export function SettingsNavigation() {
  const section = useSettingsSection();
  const { factoryId } = useParams<{ factoryId: string }>();
  const location = useLocation();
  const closeSettings = useCloseSettings();
  const { t } = useTranslation('settings');
  const { state } = useSidebar();
  const [query, setQuery] = useState('');
  // Observational memory is Mastra's; a Factory on a harness without it (Claude Code, Codex) has nothing to set there.
  const { harness, descriptor } = useFactoryHarness(factoryId ?? '');
  const factoryName = useFactoryQuery(factoryId).data?.name;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = SETTINGS_GROUPS.map(group => {
    const items = group.items.filter(({ id }) => id !== 'memory' || harness === undefined || descriptor.supports.memory);
    // The Factory group names the Factory once it is known; until then it reads «Factory».
    const label = group.id === 'factory' && factoryName ? t('groups.factoryNamed', { name: factoryName }) : group.label;
    return {
      ...group,
      label,
      items: normalizedQuery ? items.filter(({ searchText }) => searchText.includes(normalizedQuery)) : items,
    };
  }).filter(group => group.items.length > 0);

  if (!factoryId) return null;

  return (
    <>
      <Sidebar.NavList>
        <Sidebar.NavLink asChild link={{ name: t('nav.backToApp'), url: '#', icon: <ArrowLeft /> }}>
          <button type="button" aria-label={t('nav.backToApp')} onClick={closeSettings}>
            <ArrowLeft aria-hidden="true" />
            <Sidebar.NavLabel>{t('nav.backToApp')}</Sidebar.NavLabel>
          </button>
        </Sidebar.NavLink>
      </Sidebar.NavList>
      {state === 'default' && (
        <div className="py-2">
          <SearchInput
            label={t('nav.searchLabel')}
            placeholder={t('nav.searchPlaceholder')}
            value={query} onValueChange={setQuery} />
        </div>
      )}
      {filteredGroups.length > 0 ? (
        filteredGroups.map(group => {
          const headerId = `settings-${group.id}`;
          return (
            <Sidebar.NavSection key={group.id} aria-labelledby={headerId}>
              <Sidebar.NavHeader id={headerId}>{group.label}</Sidebar.NavHeader>
              <Sidebar.NavList>
                {group.items.map(({ id, label, icon: Icon }) => {
                  const isActive = section === id;
                  return (
                    <Sidebar.NavLink
                      key={id}
                      asChild
                      isActive={isActive}
                      link={{ name: label, url: '#', icon: <Icon /> }}
                    >
                      <Link
                        to={settingsSectionPath(factoryId, id)}
                        state={location.state}
                        aria-label={label}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        <Icon aria-hidden="true" />
                        <Sidebar.NavLabel>{label}</Sidebar.NavLabel>
                      </Link>
                    </Sidebar.NavLink>
                  );
                })}
              </Sidebar.NavList>
            </Sidebar.NavSection>
          );
        })
      ) : (
        <Txt as="p" variant="caption" role="status" className="px-3 py-2">
          {t('nav.noResults')}
        </Txt>
      )}
    </>
  );
}
