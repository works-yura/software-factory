import { createContext, useContext } from 'react';

/**
 * Where the Files viewer (tree, file view, download) reads a workspace from. A Factory session's
 * workspace is the default (`/web/workspace/*`, keyed by the session); «Помічник» (ADR-0051)
 * provides its request's folder (`/web/assistant/requests/:id/workspace/*`), whose server answers
 * in the same shapes, so both are drawn by the same components.
 */
export interface WorkspaceFilesEndpoints {
  /** One directory (`''` the top) as a `WorkspaceTreeListing`. */
  treeUrl(workspacePath: string, path: string): string;
  /** One file as a `WorkspaceFile`. */
  fileUrl(workspacePath: string, path: string): string;
  /** The file's bytes as a download (absolute, under `baseUrl`). */
  downloadUrl(baseUrl: string, file: { workspacePath: string; path: string }): string;
}

export const SESSION_WORKSPACE_FILES: WorkspaceFilesEndpoints = {
  treeUrl: (workspacePath, path) => `/web/workspace/tree?${new URLSearchParams({ workspacePath, path })}`,
  fileUrl: (workspacePath, path) => `/web/workspace/file?${new URLSearchParams({ workspacePath, path })}`,
  downloadUrl: (baseUrl, file) =>
    `${baseUrl}/web/workspace/file/download?${new URLSearchParams({ workspacePath: file.workspacePath, path: file.path })}`,
};

export const WorkspaceFilesEndpointsContext = createContext<WorkspaceFilesEndpoints>(SESSION_WORKSPACE_FILES);

export function useWorkspaceFilesEndpoints(): WorkspaceFilesEndpoints {
  return useContext(WorkspaceFilesEndpointsContext);
}
