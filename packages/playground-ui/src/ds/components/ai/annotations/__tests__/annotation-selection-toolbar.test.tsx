// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPLY, SECOND } from './annotating-chat';
import {
  cleanUpAnnotationTests,
  dragSelect,
  renderChat,
  settleSelection,
  textNode,
  typeAndSend,
} from './annotations-test-fixture';
import type { RenderedChat } from './annotations-test-fixture';

afterEach(cleanUpAnnotationTests);

const noteField = () => screen.getByRole('textbox', { name: 'Note for the agent' });

describe('AnnotationSelectionToolbar', () => {
  let chat: RenderedChat;
  let user: UserEvent;

  describe('when a drag runs past the end of the reply into its footer', () => {
    it('annotates only the text of the reply', async () => {
      chat = renderChat();
      dragSelect([textNode(SECOND), 'Soft rows add '.length], [textNode('Model reply footer'), 'Model'.length]);

      fireEvent.click(await screen.findByRole('button', { name: 'Add note' }));
      typeAndSend('More?');

      expect(chat.sent).toEqual(['1. > faint backgrounds.\n\nMore?']);
    });
  });

  describe('when the person writes a note on the selected passage', () => {
    beforeEach(async () => {
      user = userEvent.setup();
      chat = renderChat();
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);
      await screen.findByRole('button', { name: 'Add note' });
    });

    it('keeps the passage while the note field has focus, though the page selection collapses', async () => {
      await user.click(noteField());
      document.getSelection()?.removeAllRanges();
      fireEvent(document, new Event('selectionchange'));
      await user.keyboard('Too dense');

      expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();
      expect(noteField()).toHaveProperty('value', 'Too dense');
    });

    it('adds the passage with its note on Enter, and sends both with the next message', async () => {
      await user.click(noteField());
      await user.keyboard('Too dense{Enter}');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull());
      typeAndSend('Thoughts?');

      expect(chat.sent).toEqual(['1. > Open rows\n\n   Too dense\n\nThoughts?']);
    });

    it('keeps Shift+Enter as a new line in the note', async () => {
      await user.click(noteField());
      await user.keyboard('one{Shift>}{Enter}{/Shift}two');

      expect(noteField()).toHaveProperty('value', 'one\ntwo');
    });

    it('cancels on Escape without adding anything', async () => {
      await user.click(noteField());
      await user.keyboard('never mind{Escape}');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull());
      typeAndSend('Plain');

      expect(chat.sent).toEqual(['Plain']);
    });

    it('cancels from the Cancel button', async () => {
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull());
    });
  });

  describe('when the selection reaches into a second message', () => {
    it('offers nothing, since no single message holds the passage', async () => {
      vi.useFakeTimers();
      renderChat();
      dragSelect([textNode('Which table style should we use?'), 6], [textNode(REPLY), 9]);

      await settleSelection();

      expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    });
  });

  describe('when the browser holds a second selection range, as Firefox allows', () => {
    it('offers nothing, since one passage is one range', async () => {
      vi.useFakeTimers();
      renderChat();
      vi.spyOn(Selection.prototype, 'rangeCount', 'get').mockReturnValue(2);
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);

      await settleSelection();

      expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    });
  });

  describe('when the selected message is outside the transcript', () => {
    it('offers nothing', async () => {
      vi.useFakeTimers();
      renderChat();
      dragSelect([textNode('Outside the transcript'), 0], [textNode('Outside the transcript'), 7]);

      await settleSelection();

      expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    });
  });

  describe('when the person selects with the keyboard after a context menu swallowed the pointer release', () => {
    it('offers the note card', async () => {
      renderChat();
      const paragraph = screen.getByText(REPLY);
      fireEvent.pointerDown(paragraph, { button: 2 });
      fireEvent.contextMenu(paragraph);

      const range = document.createRange();
      range.setStart(textNode(REPLY), 0);
      range.setEnd(textNode(REPLY), 'Open rows'.length);
      document.getSelection()?.addRange(range);
      fireEvent(document, new Event('selectionchange'));

      expect(await screen.findByRole('button', { name: 'Add note' })).toBeTruthy();
    });
  });

  describe('when the person presses Escape before writing anything', () => {
    beforeEach(async () => {
      renderChat();
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);
      await screen.findByRole('button', { name: 'Add note' });
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    it('hides the card', async () => {
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull());
    });

    it('leaves the selection alone, so it can still be copied', () => {
      expect(document.getSelection()?.toString()).toBe('Open rows');
    });
  });

  describe('when the person presses Tab from the conversation while the card shows', () => {
    let conversation: HTMLElement;

    beforeEach(async () => {
      user = userEvent.setup();
      chat = renderChat();
      conversation = screen.getByRole('region', { name: 'Conversation' });
      conversation.focus();
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);
      await screen.findByRole('button', { name: 'Add note' });
      await user.tab();
    });

    it('moves focus to the note field', () => {
      expect(document.activeElement).toBe(noteField());
    });

    it('adds the passage as a quote on Enter with an empty note', async () => {
      await user.keyboard('{Enter}');
      typeAndSend('Why?');

      expect(chat.sent).toEqual(['1. > Open rows\n\nWhy?']);
    });

    it('hands focus back to the conversation on Escape', async () => {
      await user.keyboard('{Escape}');

      expect(document.activeElement).toBe(conversation);
    });
  });

  describe('when the note field is scrolled out of sight and the person presses Tab', () => {
    it('closes the card, so Tab moves on without stopping there', async () => {
      renderChat();
      const conversation = screen.getByRole('region', { name: 'Conversation' });
      conversation.focus();
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);
      await screen.findByRole('button', { name: 'Add note' });
      vi.spyOn(noteField(), 'focus').mockImplementation(() => {});

      fireEvent.keyDown(conversation, { key: 'Tab' });

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull());
    });
  });

  describe('when focus is on the page rather than the conversation and the person presses Tab', () => {
    it('leaves Tab to the browser', async () => {
      renderChat();
      dragSelect([textNode(REPLY), 0], [textNode(REPLY), 'Open rows'.length]);
      await screen.findByRole('button', { name: 'Add note' });

      const tabbedOn = fireEvent.keyDown(document.body, { key: 'Tab' });

      expect(tabbedOn).toBe(true);
    });
  });
});
