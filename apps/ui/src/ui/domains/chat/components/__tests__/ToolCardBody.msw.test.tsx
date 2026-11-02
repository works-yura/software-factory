import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { ToolCard } from '../tool/ToolCard';
import {
  claudeBashTool,
  claudeEditTool,
  claudeFactoryMcpTool,
  commandTool,
  editTool,
  longResultTool,
} from './fixtures/tool-bodies';

describe('Factory tool body', () => {
  describe('when a command streams shell output', () => {
    it('keeps shell output visible and excludes the partial structured result', async () => {
      renderWithProviders(<ToolCard tool={commandTool} />);
      await userEvent.click(screen.getByRole('button', { name: /Run/ }));

      expect(screen.getByText('Live shell output')).toBeVisible();
      expect(screen.queryByText('Partial structured output')).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Tool: execute_command' })).toHaveAttribute('aria-busy', 'true');
    });
  });

  describe('when an edit succeeds', () => {
    it('shows the change without the redundant success result', async () => {
      renderWithProviders(<ToolCard tool={editTool} />);
      await userEvent.click(screen.getByRole('button', { name: /Edit/ }));

      expect(screen.getByRole('group', { name: 'File change' })).toBeVisible();
      expect(screen.queryByText('File updated')).not.toBeInTheDocument();
    });
  });

  describe('when an edit fails', () => {
    it('shows the error beside the proposed change', async () => {
      renderWithProviders(<ToolCard tool={{ ...editTool, status: 'error', result: 'Permission denied' }} />);
      await userEvent.click(screen.getByRole('button', { name: /Edit/ }));

      expect(screen.getByRole('group', { name: 'File change' })).toBeVisible();
      expect(screen.getByText('Permission denied')).toBeVisible();
    });
  });

  describe('when a tool takes no arguments and returns nothing', () => {
    it.each([null, ''])('offers nothing to open when the result is %j', result => {
      renderWithProviders(
        <ToolCard
          tool={{
            toolCallId: 'list',
            toolName: 'list_agents',
            args: {},
            argsText: '',
            status: 'done',
            output: '',
            result,
          }}
        />,
      );

      expect(screen.getByRole('group', { name: 'Tool: list_agents' })).toBeVisible();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('when a Claude Code session calls its own tools', () => {
    it('draws Bash as a Run row showing its command', async () => {
      renderWithProviders(<ToolCard tool={claudeBashTool} />);

      const row = screen.getByRole('group', { name: 'Tool: Bash' });
      expect(within(row).getByText('Run')).toBeVisible();
      expect(within(row).getByText('pnpm test --filter ui')).toBeVisible();

      await userEvent.click(within(row).getByRole('button', { name: /Run/ }));
      expect(within(row).getByText('All tests passed')).toBeVisible();
      expect(within(row).queryByText(/"timeout"/)).not.toBeInTheDocument();
    });

    it('draws Edit as an Edit row on its file with the diff, not raw arguments', async () => {
      renderWithProviders(<ToolCard tool={claudeEditTool} />);

      const row = screen.getByRole('group', { name: 'Tool: Edit' });
      expect(within(row).getByText('src/file.ts')).toBeVisible();

      await userEvent.click(within(row).getByRole('button', { name: /Edit/ }));
      const diff = within(row).getByRole('group', { name: 'File change' });
      expect(diff).toHaveTextContent('-before');
      expect(diff).toHaveTextContent('+after');
      expect(within(row).queryByText(/"file_path"/)).not.toBeInTheDocument();
    });

    it("names a Factory MCP tool without the server's prefix", () => {
      renderWithProviders(<ToolCard tool={claudeFactoryMcpTool} />);

      const row = screen.getByRole('group', { name: 'Tool: source_control_push' });
      expect(within(row).getByText('Source control push')).toBeVisible();
      expect(screen.queryByText(/mcp__factory__/)).not.toBeInTheDocument();
    });
  });

  describe('when a result exceeds the preview limit', () => {
    it('copies the whole result', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ToolCard tool={longResultTool} />);
      await user.click(screen.getByRole('button', { name: /Read/ }));
      await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

      expect(await navigator.clipboard.readText()).toBe(longResultTool.result);
    });
  });
});
