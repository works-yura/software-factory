import { isViewerRole } from '../ui/domains/auth/services/organization';
import { useFactoryAuth } from './useFactoryAuth';

/**
 * Whether the signed-in person is a viewer in the active organization (ADR-0045): they read
 * everything and change nothing. The UI hides what a viewer cannot do; the server refuses it anyway
 * (403 `viewer_read_only`).
 */
export function useIsViewer(): boolean {
  const auth = useFactoryAuth();
  return isViewerRole(auth.data?.user?.organizationRole);
}
