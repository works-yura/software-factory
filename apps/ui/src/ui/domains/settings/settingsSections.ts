import { i18n } from '../../i18n';

export type SettingsSection =
  | 'account'
  | 'preferences'
  | 'factory'
  | 'repositories'
  | 'environment'
  | 'intake'
  | 'board'
  | 'models'
  | 'memory'
  | 'skills'
  | 'behavior';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account',
  'preferences',
  'factory',
  'repositories',
  'environment',
  'intake',
  'board',
  'models',
  'memory',
  'skills',
  'behavior',
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

type SettingsTarget = { section: SettingsSection; anchor?: ModelDefaultsAnchor };

const RETIRED_SETTINGS_SECTIONS = new Map<string, SettingsTarget>([
  ['personal-models', { section: 'models', anchor: MODEL_DEFAULTS_ANCHORS.factory }],
  ['factory-memory', { section: 'memory' }],
  // Connections held only the MCP clients card; providers connect in Repositories.
  ['connections', { section: 'repositories' }],
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

export function settingsSectionPath(factoryId: string, section: SettingsSection, anchor?: ModelDefaultsAnchor): string {
  const path = `/factories/${factoryId}/settings/${section}`;
  return anchor ? `${path}#${anchor}` : path;
}
