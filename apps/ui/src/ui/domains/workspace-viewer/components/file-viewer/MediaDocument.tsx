import { useEffect, useMemo, useState } from 'react';

import type { WorkspaceFilePreview } from '../workspace-file-preview';

/** The bytes of a `media` file, as the server sent them base64-encoded. */
export function mediaBlob(file: WorkspaceFilePreview): Blob | undefined {
  if (file.contentType !== 'media' || !file.content || !file.mimeType) return undefined;
  const binary = atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: file.mimeType });
}

/** An object URL for a media file, revoked when the file changes or the viewer closes. */
function useMediaUrl(file: WorkspaceFilePreview): string | undefined {
  const blob = useMemo(() => mediaBlob(file), [file]);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/**
 * An image or a PDF from the workspace, drawn by the browser. An SVG goes through `<img>`, where its
 * scripts do not run; a PDF is the browser's own viewer in a frame of a blob URL, which has no origin
 * of ours to reach.
 */
export function MediaDocument({ file }: { file: WorkspaceFilePreview }) {
  const url = useMediaUrl(file);
  if (!url) return null;
  if (file.mimeType === 'application/pdf') {
    return <iframe src={url} title={file.name} className="h-[70vh] w-full rounded-md border-0 bg-white" />;
  }
  return (
    <div className="flex justify-center">
      <img
        src={url}
        alt={file.name}
        className="bg-surface2 max-w-full rounded-md object-contain"
      />
    </div>
  );
}
