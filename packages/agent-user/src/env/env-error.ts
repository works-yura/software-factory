export class AgentEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEnvError';
  }
}
