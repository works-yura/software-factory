import { describe, expect, it } from 'vitest';

import { connectionsPath, isSettingsSection, retiredSettingsTarget } from './settingsSections';

describe('Settings › Підключення', () => {
  it('sends the retired «Логи і креші» and «MCP-сервери» pages to Підключення', () => {
    expect(retiredSettingsTarget('observability', '')).toEqual({ section: 'integrations', search: '?connection=google-cloud' });
    expect(retiredSettingsTarget('mcp-servers', '')).toEqual({ section: 'integrations' });
    expect(isSettingsSection('observability')).toBe(false);
    expect(isSettingsSection('mcp-servers')).toBe(false);
    expect(isSettingsSection('integrations')).toBe(true);
  });

  it('links the list, or one integration to open', () => {
    expect(connectionsPath('fp-1')).toBe('/factories/fp-1/settings/integrations');
    expect(connectionsPath('fp-1', 'clickup')).toBe('/factories/fp-1/settings/integrations?connection=clickup');
  });
});
