import { createContext } from 'react';
import type { ReactNode } from 'react';

import type { WorkspacePanelSize } from '../layout';

export interface WorkspacePanelApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspacePath?: string;
  threadId?: string;
  size: WorkspacePanelSize;
  setSize: (size: WorkspacePanelSize) => void;
  canDock: boolean;
  /** Whether the overview may read changes without waking an idle sandbox nobody asked for. */
  readsChanges: boolean;
  /** Opens the panel on a workspace file, by its path relative to the workspace root. */
  openFile: (path: string) => void;
  /** The last file asked for with `openFile`; `request` changes on every ask, so asking twice reopens it. */
  requestedFile?: { path: string; request: number };
  /** What the card or popover shows; a session's Files (`WorkspaceFilesContent`) when unset. */
  content?: ReactNode;
}

export const WorkspacePanelContext = createContext<WorkspacePanelApi | undefined>(undefined);
