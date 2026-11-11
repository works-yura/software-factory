import { describe, expect, it } from 'vitest';

import { integrationsPath, isSettingsSection, retiredSettingsTarget } from './settingsSections';

describe('Settings › Інтеграції', () => {
  it('sends the retired «Логи і креші» and «MCP-сервери» pages to their place in Інтеграції', () => {
    expect(retiredSettingsTarget('observability', '')).toEqual({
      section: 'integrations',
      search: '?tab=services&service=google-cloud',
    });
    expect(retiredSettingsTarget('mcp-servers', '')).toEqual({ section: 'integrations', search: '?tab=mcp' });
    expect(isSettingsSection('observability')).toBe(false);
    expect(isSettingsSection('mcp-servers')).toBe(false);
    expect(isSettingsSection('integrations')).toBe(true);
  });

  it('links a tab and, on Сервіси, the service to open', () => {
    expect(integrationsPath('fp-1', { tab: 'mcp' })).toBe('/factories/fp-1/settings/integrations?tab=mcp');
    expect(integrationsPath('fp-1', { tab: 'services', service: 'clickup' })).toBe(
      '/factories/fp-1/settings/integrations?tab=services&service=clickup',
    );
  });
});
