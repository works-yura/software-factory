import { createDeviceApi, defaultDeviceModelUrls, DevicePanel } from '@factory/device/react';
import { Button } from '@mastra/playground-ui/components/Button';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';

/** Where the server mounts device preview (`DEVICE_BASE_PATH` in `@factory/server`). */
const DEVICE_BASE_PATH = '/web/device';

interface WorkspaceDevicePanelProps {
  /** Owns the device sessions the panel opens: the Factory session, else the workspace. */
  threadId: string;
  visible: boolean;
  onBack: () => void;
}

/** Simulators and emulators on the server's machine, streamed into the session panel. */
export default function WorkspaceDevicePanel({ threadId, visible, onBack }: WorkspaceDevicePanelProps) {
  const { t } = useTranslation('workspaces');
  const { baseUrl } = useApiConfig();
  const api = useMemo(() => createDeviceApi({ basePath: `${baseUrl}${DEVICE_BASE_PATH}` }), [baseUrl]);
  const modelUrls = useMemo(() => defaultDeviceModelUrls(), []);

  return (
    <section className="flex min-h-0 min-w-0 grow flex-col" aria-label={t('device.label')} data-testid="workspace-device-panel">
      <div className="border-border flex min-h-10 items-center gap-1 border-b px-1.5 py-1">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label={t('device.back')}>
          <ArrowLeft />
        </Button>
        <span className="text-sm">{t('device.label')}</span>
      </div>
      <DevicePanel threadId={threadId} api={api} modelUrls={modelUrls} visible={visible} className="min-h-0 grow" />
    </section>
  );
}
