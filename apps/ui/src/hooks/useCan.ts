import { useFactoryAuth } from './useFactoryAuth';

/**
 * Whether the signed-in person may do something here (ADR-0045): the permission is in the list
 * `/auth/me` reports for their role. The UI hides what they cannot do; the server refuses it
 * anyway. With sign-in off there is one local operator, who may do everything. Before the auth
 * state has loaded (never on a routed page) the control shows; the server still decides.
 */
export function useCan(permission: string): boolean {
  const auth = useFactoryAuth();
  // The route guards load the auth state before any page renders, so this is known wherever a
  // control asks. A failed load allows nothing.
  if (auth.isError) return false;
  if (!auth.data) return true;
  if (!auth.data.authEnabled) return true;
  return auth.data.user?.permissions?.includes(permission) ?? false;
}
