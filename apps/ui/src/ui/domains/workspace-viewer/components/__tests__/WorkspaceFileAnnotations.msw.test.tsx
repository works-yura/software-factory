import { ChatAnnotationsProvider, useChatAnnotations } from '@mastra/playground-ui/components/ai/annotations';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { WorkspaceFileViewer } from '../WorkspaceFileViewer';
import type { WorkspaceFilePreview } from '../workspace-file-preview';

const file = {
  name: 'requirements.md',
  path: 'docs/changes/2026-11-10-notifications/requirements.md',
  language: 'markdown',
  contentType: 'text',
  content: '# Brief\n\nThe owner gets a push for every new booking.',
  size: 48,
} as unknown as WorkspaceFilePreview;

function Viewer() {
  return (
    <WorkspaceFileViewer
      filePath={file.path}
      file={file}
      isLoading={false}
      isRefreshing={false}
      onRefresh={() => {}}
      onBack={() => {}}
    />
  );
}

function Count() {
  const { annotations } = useChatAnnotations();
  return <output aria-label="annotation count">{annotations.length}</output>;
}

describe('WorkspaceFileViewer annotations', () => {
  it('marks a markdown document as annotatable inside a chat', () => {
    renderWithProviders(
      <ChatAnnotationsProvider>
        <Viewer />
        <Count />
      </ChatAnnotationsProvider>,
    );

    const paragraph = screen.getByText('The owner gets a push for every new booking.');
    expect(paragraph.closest('[data-slot="message-content"]')).not.toBeNull();
    expect(screen.getByLabelText('annotation count')).toHaveTextContent('0');
  });

  it('still renders the document outside a chat', () => {
    renderWithProviders(<Viewer />);

    expect(screen.getByText('The owner gets a push for every new booking.')).toBeInTheDocument();
  });

  it('opens the document full screen and keeps it annotatable there', async () => {
    renderWithProviders(
      <ChatAnnotationsProvider>
        <Viewer />
      </ChatAnnotationsProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'requirements.md' });
    const paragraph = Array.from(dialog.querySelectorAll('p')).find(p => p.textContent?.includes('push for every new booking'));
    expect(paragraph?.closest('[data-slot="message-content"]')).not.toBeNull();
  });
});
