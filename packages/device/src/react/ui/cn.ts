/**
 * Joins truthy class names. Unlike t3code's `cn` it does not resolve conflicting
 * Tailwind utilities (no tailwind-merge), so callers avoid passing conflicts.
 */
export type ClassValue = string | false | null | undefined | 0;

export function cn(...inputs: ReadonlyArray<ClassValue>): string {
  return inputs.filter(Boolean).join(" ");
}
