// Fake connectors through the shared UI harness: a source (Acme Cloud) and an agent (Robo Agent).
import type { ConnectionView } from '@factory/contracts';

import { acmeConnection, acmeConnector, roboAgentConnector } from './fixtures/connections';
import { describeConnectorUi } from './fixtures/connectorUiContract';

describeConnectorUi('Acme Cloud', () => ({
  connector: acmeConnector,
  connections: [acmeConnection],
  sections: [
    { type: 'facts', title: 'Account', rows: [{ label: 'Team', value: 'acme-team' }] },
    { type: 'table', title: 'Projects', columns: ['Name'], rows: [{ cells: ['ACME-web'] }] },
  ],
  impact: {
    title: 'Delete «Acme main»?',
    body: 'Its key is erased.',
    dependents: [],
    items: [{ label: 'ACME-web', outcome: 'stops', outcomeLabel: 'Stops importing' }],
    confirmLabel: 'Delete',
    cancelLabel: 'Keep',
    requiresConfirm: true,
  },
}));

const roboAccount: ConnectionView = {
  id: 'robo:acct-1',
  connector: { id: 'robo', name: 'Robo Agent', icon: 'robo' },
  label: 'ann@robo.test',
  status: 'active',
  displayName: null,
  accountLabel: 'ann@robo.test',
  accountDetail: 'Yours · pro',
  method: 'Sign in with Robo',
  provides: [{ key: 'agent', label: 'Runs Robo Agent sessions' }],
  state: { tone: 'warning', label: 'Out of usage until 17:00' },
  scope: 'organization',
  actions: { rename: true, reconnect: { method: roboAgentConnector.methods[0]! }, remove: true },
};

describeConnectorUi('Robo Agent', () => ({
  connector: roboAgentConnector,
  connections: [roboAccount],
  sections: [
    { type: 'facts', title: 'Account', rows: [{ label: 'Owner', value: 'Yours' }] },
    { type: 'table', title: 'Usage limits', columns: ['Window', 'Used', 'Resets'], rows: [{ cells: ['5-hour', '42%', '15:00'] }] },
    { type: 'settings', id: 'rotation', title: 'Rotation', fields: [{ name: 'enabled', displayName: 'In rotation', type: 'boolean', required: false, value: true }] },
  ],
  impact: {
    title: 'Remove ann@robo.test?',
    body: 'Your only Robo Agent account.',
    dependents: [{ label: 'Shop' }],
    items: [{ label: 'Shop', outcome: 'stops', outcomeLabel: 'Your sessions stop' }],
    confirmLabel: 'Remove account',
    cancelLabel: 'Cancel',
    requiresConfirm: true,
  },
}));
