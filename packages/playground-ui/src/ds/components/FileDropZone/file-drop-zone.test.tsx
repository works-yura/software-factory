// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileDropZone } from './file-drop-zone';

afterEach(() => {
  cleanup();
});

const file = (name: string) => new File(['A=1'], name, { type: 'text/plain' });

const renderZone = (props: Partial<Parameters<typeof FileDropZone>[0]> = {}) => {
  const onFiles = vi.fn();
  render(<FileDropZone title="Drop a .env file here" buttonLabel="Choose file" onFiles={onFiles} {...props} />);
  return { onFiles, zone: screen.getByRole('group', { name: 'Drop a .env file here' }) };
};

describe('FileDropZone', () => {
  it('passes on a file dropped onto the zone and marks the zone while dragging', () => {
    const { onFiles, zone } = renderZone();
    const dropped = file('.env');

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [] } });
    expect(zone.hasAttribute('data-dragging')).toBe(true);
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [dropped] } });

    expect(onFiles).toHaveBeenCalledWith([dropped]);
    expect(zone.hasAttribute('data-dragging')).toBe(false);
  });

  it('ignores drags that carry no files', () => {
    const { onFiles, zone } = renderZone();

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'], files: [] } });
    fireEvent.drop(zone, { dataTransfer: { types: ['text/plain'], files: [] } });

    expect(zone.hasAttribute('data-dragging')).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('passes on only the first file unless multiple', () => {
    const { onFiles, zone } = renderZone();
    const first = file('a.env');

    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [first, file('b.env')] } });

    expect(onFiles).toHaveBeenCalledWith([first]);
  });

  it('passes on a file chosen through the button', async () => {
    const user = userEvent.setup();
    const { onFiles } = renderZone();
    const chosen = file('service-account.json');

    expect((screen.getByRole('button', { name: 'Choose file' }) as HTMLButtonElement).disabled).toBe(false);
    await user.upload(screen.getByLabelText('Choose file'), chosen);

    expect(onFiles).toHaveBeenCalledWith([chosen]);
  });

  it('takes nothing while disabled', () => {
    const { onFiles, zone } = renderZone({ disabled: true });

    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file('.env')] } });

    expect(onFiles).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Choose file' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
