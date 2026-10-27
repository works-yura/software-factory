import { i18n } from '../../i18n';

export type SettingsSection =
  | 'account'
  | 'preferences'
  | 'factory'
  | 'connections'
  | 'repositories'
  | 'environment'
  | 'intake'
  | 'models'
  | 'personal-models'
  | 'memory'
  | 'factory-memory'
  | 'skills'
  | 'behavior';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account',
  'preferences',
  'factory',
  'connections',
  'repositories',
  'environment',
  'intake',
  'models',
  'personal-models',
  'memory',
  'factory-memory',
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

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && value in SETTINGS_SECTION_LABELS;
}

export function settingsSectionPath(factoryId: string, section: SettingsSection): string {
  return `/factories/${factoryId}/settings/${section}`;
}
