import { i18n } from '../../i18n';

export type SettingsSection =
  | 'account'
  | 'preferences'
  | 'factory'
  | 'analytics'
  | 'repositories'
  | 'environment'
  | 'intake'
  | 'integrations'
  | 'models'
  | 'memory'
  | 'behavior'
  | 'debug';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account',
  'preferences',
  'factory',
  'analytics',
  'repositories',
  'environment',
  'intake',
  'integrations',
  'models',
  'memory',
  'behavior',
  'debug',
];

/** Section titles in the interface language; each is looked up when read. */
export const SETTINGS_SECTION_LABELS = {} as Readonly<Record<SettingsSection, string>>;
for (const section of SETTINGS_SECTIONS) {
  Object.defineProperty(SETTINGS_SECTION_LABELS, section, {
    enumerable: true,
    get: () => i18n.t(`sections.${section}`, { ns: 'settings' }),
  });
}

/** Every session and work-item run uses the Factory defaults, so they are the only defaults a link opens. */
export const MODEL_DEFAULTS_ANCHORS = {
  factory: 'factory-defaults',
} as const;

export type ModelDefaultsAnchor = (typeof MODEL_DEFAULTS_ANCHORS)[keyof typeof MODEL_DEFAULTS_ANCHORS];

/** Work Intake's list of routes that decide where new cards land. */
export const NEW_CARD_ROUTES_ANCHOR = 'new-cards';

type SettingsAnchor = ModelDefaultsAnchor | typeof NEW_CARD_ROUTES_ANCHOR;

type SettingsTarget = { section: SettingsSection; anchor?: ModelDefaultsAnchor; search?: string };

/** The tabs of Settings › Інтеграції, kept in the URL (`?tab=`), and the service a link opens. */
export type IntegrationsTab = 'services' | 'mcp';
export type IntegrationsService = 'google-cloud' | 'clickup' | 'github' | 'gitlab';

function integrationsSearch(target: { tab: IntegrationsTab; service?: IntegrationsService }): string {
  const params = new URLSearchParams({ tab: target.tab, ...(target.service ? { service: target.service } : {}) });
  return `?${params.toString()}`;
}

const RETIRED_SETTINGS_SECTIONS = new Map<string, SettingsTarget>([
  ['personal-models', { section: 'models', anchor: MODEL_DEFAULTS_ANCHORS.factory }],
  ['factory-memory', { section: 'memory' }],
  // Connections held only the MCP clients card; providers connect in Repositories.
  ['connections', { section: 'repositories' }],
  // Usage became Analytics, which now lives in Settings.
  ['usage', { section: 'analytics' }],
  // Logs and crashes became the Google Cloud service, MCP servers a tab, both in Інтеграції.
  ['observability', { section: 'integrations', search: integrationsSearch({ tab: 'services', service: 'google-cloud' }) }],
  ['mcp-servers', { section: 'integrations', search: integrationsSearch({ tab: 'mcp' }) }],
]);

export function retiredSettingsTarget(section: string | undefined, hash: string): SettingsTarget | undefined {
  if (section === 'models' && hash === '#model-packs')
    return { section: 'models', anchor: MODEL_DEFAULTS_ANCHORS.factory };
  if (!section) return undefined;
  return RETIRED_SETTINGS_SECTIONS.get(section);
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && value in SETTINGS_SECTION_LABELS;
}

export function settingsSectionPath(factoryId: string, section: SettingsSection, anchor?: SettingsAnchor): string {
  const path = `/factories/${factoryId}/settings/${section}`;
  return anchor ? `${path}#${anchor}` : path;
}

/** A link into Settings › Інтеграції: a tab, and on «Сервіси» the service to open. */
export function integrationsPath(factoryId: string, target: { tab: IntegrationsTab; service?: IntegrationsService }): string {
  return `${settingsSectionPath(factoryId, 'integrations')}${integrationsSearch(target)}`;
}
