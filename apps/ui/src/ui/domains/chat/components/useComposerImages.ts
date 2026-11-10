import { useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react';

import type { PendingImage } from '../context/ComposerImagesContext';
import { useComposerImagesState } from '../context/useComposerImagesState';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

let pendingImageSequence = 0;

// base64 inflates ~33% and attachments travel in a JSON POST body
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(tk('composer.readFileFailed')));
    reader.readAsDataURL(file);
  });
}

/** A non-image file (or an image the model is not shown) waiting to be attached to the session's card. */
export interface PendingFile {
  id: string;
  file: File;
}

/**
 * The composer's pending images (shown to the model) and files (uploaded as attachments on send).
 * `acceptFiles: false` keeps the old images-only behaviour (a draft has no session to attach to);
 * `imagesToModel: false` treats images as files too (a harness that takes no images).
 */
export function useComposerImages({
  disabled,
  acceptFiles = false,
  imagesToModel = true,
}: {
  disabled: boolean;
  acceptFiles?: boolean;
  imagesToModel?: boolean;
}) {
  const { images, setImages } = useComposerImagesState();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isModelImage = (file: File) => imagesToModel && file.type.startsWith('image/') && file.size <= MAX_IMAGE_BYTES;
  const accepts = (file: File) => acceptFiles || isModelImage(file);

  const addFiles = async (fileList: Iterable<File>) => {
    const all = Array.from(fileList);
    if (acceptFiles) {
      const others = all.filter(file => !isModelImage(file));
      if (others.length > 0) {
        setFiles(current => [...current, ...others.map(file => ({ id: `pending-file-${pendingImageSequence++}`, file }))]);
      }
    }
    await addImageFiles(all.filter(isModelImage));
  };

  const addImageFiles = async (fileList: Iterable<File>) => {
    const imageFiles = Array.from(fileList);
    if (imageFiles.length === 0) return;

    let budget = MAX_TOTAL_IMAGE_BYTES - images.reduce((sum, image) => sum + Math.floor(image.data.length * 0.75), 0);
    const accepted = imageFiles.filter(file => {
      if (file.size > budget) return false;
      budget -= file.size;
      return true;
    });
    if (accepted.length === 0) return;

    const additions = await Promise.all(
      accepted.map(
        async (file): Promise<PendingImage> => ({
          id: `pending-image-${pendingImageSequence++}`,
          data: await readFileAsBase64(file),
          mediaType: file.type,
          filename: file.name || undefined,
        }),
      ),
    );
    setImages(current => [...current, ...additions]);
  };

  const removeImage = (id: string) => {
    setImages(current => current.filter(image => image.id !== id));
  };

  const removeFile = (id: string) => {
    setFiles(current => current.filter(file => file.id !== id));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData?.files ?? []).filter(accepts);
    if (pasted.length === 0) return;
    event.preventDefault();
    if (disabled) return;
    void addFiles(pasted);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []).filter(accepts);
    if (dropped.length === 0) return;
    void addFiles(dropped);
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!disabled) void addFiles(Array.from(event.target.files ?? []).filter(accepts));
    event.target.value = '';
  };

  return { images, setImages, files, setFiles, fileInputRef, removeImage, removeFile, onPaste, onDrop, onFileInputChange };
}
