/** The system executables the launch chain runs, by absolute path: never looked up on a PATH. */
export const SYSTEM_BINARIES = {
  sudo: '/usr/bin/sudo',
  env: '/usr/bin/env',
  sh: '/bin/sh',
  cat: '/bin/cat',
  sandboxExec: '/usr/bin/sandbox-exec',
  kill: '/bin/kill',
} as const;

/** The PATH every agent command ends with, and the only PATH sudo itself gets. */
export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;
