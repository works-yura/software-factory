import { PROVIDER_AUTH_REQUIRED_ERROR } from '@mastra/code-sdk/auth/provider-auth-error';

import {
  classifyProviderError,
  PROVIDER_CALL_ERROR_NAME,
  providerErrorReason,
  providerModelId,
} from './provider-error.ts';

export type RunErrorRecovery = 'credentials' | 'model';

export interface RunErrorDescription {
  title: string;
  message: string;
  recoveries: RunErrorRecovery[];
  model?: string;
}

export interface RunErrorIdentity {
  name: string;
  message: string;
}

/**
 * The words a run error is described with. English by default; a UI passes its
 * own translation. The provider's reason is quoted as the provider wrote it.
 */
export interface RunErrorCopy {
  titles: {
    signIn: string;
    quota: string;
    auth: string;
    contextOverflow: string;
    modelRejected: string;
    toolHistoryRejected: string;
    invalidRequest: string;
    timeout: string;
    rateLimited: string;
    unavailable: string;
    modelRequestFailed: string;
    runStopped: string;
  };
  messages: {
    quotaNext: string;
    authNext: string;
    contextOverflow: string;
    modelRejectedNext: string;
    modelRejectedFallback: string;
    toolHistoryRejected: string;
    timeout: string;
    rateLimited: string;
    unavailable: string;
    noReason: string;
    unexpected: string;
  };
}

export const RUN_ERROR_COPY: RunErrorCopy = {
  titles: {
    signIn: 'Provider sign-in required',
    quota: 'Provider quota exhausted',
    auth: 'Provider access failed',
    contextOverflow: 'Conversation exceeds the model’s limit',
    modelRejected: 'Model not available',
    toolHistoryRejected: 'Conversation history rejected',
    invalidRequest: 'Model request rejected',
    timeout: 'Request timed out',
    rateLimited: 'Provider rate limit reached',
    unavailable: 'Model provider temporarily unavailable',
    modelRequestFailed: 'Model request failed',
    runStopped: 'Run stopped',
  },
  messages: {
    quotaNext: 'Check the provider account’s billing or usage allowance, or use another credential or model.',
    authNext: 'Review the credentials and model access configured for this session.',
    contextOverflow: 'Choose a model with a larger context window or start a new session with a shorter prompt.',
    modelRejectedNext: 'Choose another model for this session.',
    modelRejectedFallback: 'The provider rejected this model.',
    toolHistoryRejected:
      'The provider could not match a tool call with its result. Copy the error details so this session can be investigated.',
    timeout: 'The request took too long to complete. Send a message to continue the run.',
    rateLimited: 'Wait a moment, then send a message to continue the run.',
    unavailable: 'The provider could not complete the request. Send a message to continue the run.',
    noReason:
      'The provider rejected the request. A specific reason isn’t available here. Copy the error details and check the server logs.',
    unexpected: 'An unexpected error stopped the run. Copy the error details to investigate.',
  },
};

export function describeRunError(error: RunErrorIdentity, copy: RunErrorCopy = RUN_ERROR_COPY): RunErrorDescription {
  return { ...explainRunError(error, copy), model: providerModelId(error) };
}

function explainRunError(error: RunErrorIdentity, { titles, messages }: RunErrorCopy): Omit<RunErrorDescription, 'model'> {
  if (error.name === PROVIDER_AUTH_REQUIRED_ERROR) {
    return { title: titles.signIn, message: error.message, recoveries: ['credentials', 'model'] };
  }
  switch (classifyProviderError(error)) {
    case 'quota':
      return {
        title: titles.quota,
        message: afterProviderReason(error, messages.quotaNext),
        recoveries: ['credentials', 'model'],
      };
    case 'auth':
      return {
        title: titles.auth,
        message: afterProviderReason(error, messages.authNext),
        recoveries: ['credentials', 'model'],
      };
    case 'context_overflow':
      return { title: titles.contextOverflow, message: messages.contextOverflow, recoveries: ['model'] };
    case 'model_rejected':
      return {
        title: titles.modelRejected,
        message: afterProviderReason(error, messages.modelRejectedNext, messages.modelRejectedFallback),
        recoveries: ['model'],
      };
    case 'tool_history_rejected':
      return { title: titles.toolHistoryRejected, message: messages.toolHistoryRejected, recoveries: [] };
    case 'invalid_request':
      return {
        title: titles.invalidRequest,
        message: providerErrorReason(error) ?? messages.noReason,
        recoveries: [],
      };
    case 'timeout':
      return { title: titles.timeout, message: messages.timeout, recoveries: [] };
    case 'rate_limited':
      return { title: titles.rateLimited, message: messages.rateLimited, recoveries: [] };
    case 'unavailable':
      return { title: titles.unavailable, message: messages.unavailable, recoveries: [] };
    case 'unknown':
      return describeUnclassifiedError(error, titles, messages);
  }
}

function afterProviderReason(error: RunErrorIdentity, next: string, fallback?: string): string {
  const reason = providerErrorReason(error) ?? fallback;
  return reason ? `${reason.replace(/\.?$/, '.')} ${next}` : next;
}

function describeUnclassifiedError(
  error: RunErrorIdentity,
  titles: RunErrorCopy['titles'],
  messages: RunErrorCopy['messages'],
): Omit<RunErrorDescription, 'model'> {
  const message = providerErrorReason(error) ?? (error.message || messages.unexpected);
  return {
    title: PROVIDER_CALL_ERROR_NAME.test(error.name) ? titles.modelRequestFailed : titles.runStopped,
    message,
    recoveries: [],
  };
}
