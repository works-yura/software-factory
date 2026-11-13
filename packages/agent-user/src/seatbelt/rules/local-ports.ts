import type { ProfileSection } from '../profile-section.ts';
import { remoteIp } from '../sbpl.ts';

/** The Factory server and the owner's Chrome debugger. */
export const DEFAULT_DENIED_LOCAL_PORTS = [5874, 9222] as const;

/** No connection to local services that are not the agent's. */
export function denyLocalPorts(ports: readonly number[]): ProfileSection {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`${port} is not a TCP port.`);
  }
  return {
    title: 'Local services that are not the agent’s: none.',
    rules: ports.length ? [{ action: 'deny', operations: ['network-outbound'], filters: ports.map(port => remoteIp(`localhost:${port}`)) }] : [],
  };
}
