import { GlobalSearchOverlay } from '../../search/components/GlobalSearchOverlay';
import { useOverlays } from '../../../lib/overlays';
import { AssistantOverlay } from '../../assistant/AssistantOverlay';
import { useOptionalActiveFactory } from '../../workspaces/components/FactoryLayout';
import { ShortcutsOverlay } from './ShortcutsOverlay';

/** Mounts overlays that intentionally sit above the application layout. */
export function ChatOverlays() {
  const overlays = useOverlays();
  // The page's Factory is only a hint («Factory X?») for the assistant.
  const factory = useOptionalActiveFactory();
  return (
    <>
      <GlobalSearchOverlay />
      {overlays.isOpen('shortcuts') && <ShortcutsOverlay />}
      <AssistantOverlay {...(factory ? { factory: { id: factory.id, name: factory.name } } : {})} />
    </>
  );
}
