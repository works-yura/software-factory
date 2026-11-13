/** A sandbox a command runs under, rendered as the text its runner takes (a Seatbelt profile). */
export interface SandboxPolicy {
  render(): string;
}
