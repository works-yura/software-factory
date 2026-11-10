import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { PortalContainerProvider } from '@mastra/playground-ui/primitives/portal-container';
import { useState } from 'react';

import type { WorkspaceFilePreview } from '../workspace-file-preview';
import { SendNotesButton } from './FileAnnotations';
import { FileDocument } from './FileDocument';

/** The file full screen at a reading width, still open to notes, with "Send all" in its header. */
export function ExpandedFileDialog({
  file,
  filePath,
  onClose,
}: {
  file: WorkspaceFilePreview;
  filePath: string;
  onClose: () => void;
}) {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const title = file.name ?? filePath;
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="full" aria-label={title}>
        {/* Popups opened inside the dialog (the note card, a marker's note) mount here, inside its focus trap. */}
        <div ref={setPortalHost} className="absolute" />
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-3">
            <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
            <SendNotesButton onSent={onClose} />
          </div>
          <Txt tone="muted" as="span" variant="caption" className="truncate">
            {file.path}
          </Txt>
        </DialogHeader>
        <PortalContainerProvider container={portalHost}>
          <DialogBody>
            <div className="mx-auto w-full max-w-[52rem]">
              <FileDocument file={file} filePath={filePath} />
            </div>
          </DialogBody>
        </PortalContainerProvider>
      </DialogContent>
    </Dialog>
  );
}
