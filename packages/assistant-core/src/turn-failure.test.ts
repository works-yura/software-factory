import { describe, expect, it } from 'vitest';

import { AssistantError } from './errors.ts';
import { AssistantTurnError, classifyTurnFailure, parseTurnFailure, serializeTurnFailure } from './turn-failure.ts';

/** The AI SDK's `APICallError` as a provider failure arrives (its fields, not the class). */
function apiCallError(message: string, statusCode: number, responseBody: string) {
  return Object.assign(new Error(message), { name: 'AI_APICallError', statusCode, responseBody });
}

describe('why a turn failed', () => {
  it('reads an xAI 429 resource-exhausted answer as a rate limit / no credits, naming the model', () => {
    const body = JSON.stringify({
      code: 'Some resource has been exhausted',
      error: 'Your team has either used all available credits or reached its monthly spending limit.',
    });
    const failure = classifyTurnFailure(new AssistantTurnError('xai/grok-4.5', apiCallError('Too Many Requests', 429, body)));
    expect(failure).toMatchObject({ kind: 'rate_limit', modelId: 'xai/grok-4.5', status: 429 });
    expect(failure.detail).toContain('Too Many Requests');
    expect(failure.detail).toContain('resource has been exhausted');
  });

  it('finds the status behind the AI SDK retry wrapper', () => {
    const retry = Object.assign(new Error('Failed after 3 attempts. Last error: Too Many Requests'), {
      name: 'AI_RetryError',
      lastError: apiCallError('Too Many Requests', 429, '{"code":"resource-exhausted"}'),
    });
    expect(classifyTurnFailure(new AssistantTurnError('xai/grok-4.5', retry))).toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('reads xAI no credits without a 429 as a rate limit too', () => {
    const failure = classifyTurnFailure(
      new AssistantTurnError('xai/grok-4.5', apiCallError('Forbidden', 403, '{"error":"Your team has no credits yet."}')),
    );
    expect(failure).toMatchObject({ kind: 'rate_limit', status: 403 });
  });

  it('reads 401 as an invalid key', () => {
    const failure = classifyTurnFailure(
      new AssistantTurnError('openai/gpt-5', apiCallError('Incorrect API key provided', 401, '{"error":{"code":"invalid_api_key"}}')),
    );
    expect(failure).toMatchObject({ kind: 'auth', modelId: 'openai/gpt-5', status: 401 });
  });

  it('reads 404 as a model the provider does not have', () => {
    const failure = classifyTurnFailure(
      new AssistantTurnError('anthropic/claude-x', apiCallError('model: claude-x', 404, '{"type":"not_found_error"}')),
    );
    expect(failure).toMatchObject({ kind: 'model_not_found', status: 404 });
  });

  it('reads 503 as an overloaded provider', () => {
    const failure = classifyTurnFailure(
      new AssistantTurnError('anthropic/claude-sonnet', apiCallError('Service Unavailable', 503, 'Overloaded')),
    );
    expect(failure).toMatchObject({ kind: 'overloaded', status: 503 });
  });

  it('reads the organization without a model as no model, and anything else as unknown', () => {
    expect(classifyTurnFailure(new AssistantError('no_org_model', 'No model connected.', 409))).toMatchObject({
      kind: 'no_model',
      modelId: null,
    });
    expect(classifyTurnFailure(new Error('socket hang up'))).toMatchObject({ kind: 'unknown', modelId: null, detail: 'socket hang up' });
  });

  it('round-trips as stored, and a plain text stored before is an unknown failure', () => {
    const failure = classifyTurnFailure(new AssistantTurnError('xai/grok-4.5', apiCallError('Too Many Requests', 429, '')));
    expect(parseTurnFailure(serializeTurnFailure(failure))).toEqual(failure);
    expect(parseTurnFailure('Too Many Requests')).toEqual({ kind: 'unknown', modelId: null, status: null, detail: 'Too Many Requests' });
    expect(parseTurnFailure(null)).toBeNull();
  });
});
