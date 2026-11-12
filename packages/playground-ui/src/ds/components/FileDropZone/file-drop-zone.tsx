import { FileUpIcon } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import { Button } from '@/ds/components/Button';
import { Txt } from '@/ds/components/Txt';
import { cn } from '@/lib/utils';

export interface FileDropZoneProps {
  /** Called with the files dropped on the zone or chosen through the button. */
  onFiles: (files: File[]) => void;
  /** The zone's heading, e.g. "Drop a .env file here". Also names the zone for assistive tech. */
  title: ReactNode;
  /** A line under the title, e.g. "or choose a file from your computer". */
  description?: ReactNode;
  /** The button that opens the system file picker; also names the hidden file input. */
  buttonLabel: string;
  /** Same format as the HTML `accept` attribute; only filters the system picker. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
}

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * A dashed area that takes a file dropped onto it or chosen with its button. Unlike `FileDropBackdrop`,
 * which catches drops anywhere in the window, it accepts only what lands on the zone itself, so a form
 * can hold one next to the field the file fills.
 *
 * ```tsx
 * <FileDropZone title="Drop a .env file here" buttonLabel="Choose file" onFiles={([file]) => read(file)} />
 * ```
 */
export function FileDropZone({
  onFiles,
  title,
  description,
  buttonLabel,
  accept,
  multiple = false,
  disabled = false,
  className,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const deliver = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-slot="file-drop-zone"
      data-dragging={dragging || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center',
        'data-[dragging]:border-border-focus data-[dragging]:bg-fill-hover',
        'data-[disabled]:opacity-50',
        className,
      )}
      onDragEnter={event => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={event => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
      }}
      onDragLeave={event => {
        if (disabled || !hasFiles(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={event => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        deliver(event.dataTransfer.files);
      }}
    >
      <FileUpIcon aria-hidden className="size-5 text-muted-foreground" />
      <Txt as="p" variant="body-sm" id={titleId}>
        {title}
      </Txt>
      {description && (
        <Txt as="p" variant="caption" tone="muted">
          {description}
        </Txt>
      )}
      <Button type="button" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {buttonLabel}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={buttonLabel}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={event => {
          deliver(event.target.files);
          // Choosing the same file again should fire again.
          event.target.value = '';
        }}
      />
    </div>
  );
}
