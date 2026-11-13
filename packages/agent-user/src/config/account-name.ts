/** Account names macOS accepts and that neither a shell nor a sudoers line can misread. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function isAccountName(value: string): boolean {
  return ACCOUNT_NAME.test(value);
}
