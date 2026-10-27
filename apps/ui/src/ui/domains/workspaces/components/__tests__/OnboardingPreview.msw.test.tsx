import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { OnboardingPreview } from '../onboarding/preview/OnboardingPreview';

describe('contextual onboarding previews', () => {
  it('shows the company Factory model in review for work and sessions', () => {
    renderWithProviders(
      <OnboardingPreview
        step="review"
        providerId="anthropic"
        model="anthropic/claude-fable-5"
        connectionMethod="api_key"
      />,
    );
    const accountsScene = screen.getByLabelText('Account setup preview');
    expect(accountsScene.closest('[data-active]')).toHaveAttribute('data-active', 'true');
    const accounts = within(accountsScene);
    expect(within(accounts.getByLabelText('Factory work model')).getByText('anthropic/claude-fable-5')).toBeVisible();
    expect(within(accounts.getByLabelText('Session model')).getByText('anthropic/claude-fable-5')).toBeVisible();
    expect(accounts.getByText('Same model for sessions')).toBeVisible();
    expect(accounts.getByText('API key')).toBeVisible();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
