import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { clampSelection, findAnnotatablePart, selectionAnchor, annotationSource } from './annotatable-selection';
import type { SelectionAnchor, AnnotationSource } from './annotatable-selection';
import { normalizeAnnotationText } from './format-annotated-message';

export interface AnnotationSelection {
  text: string;
  source: AnnotationSource;
  anchor: SelectionAnchor;
}

interface AnnotationSelectionState {
  open: boolean;
  /** Kept after closing so the toolbar stays in place while it animates out. */
  selection?: AnnotationSelection;
}

const CLOSED: AnnotationSelectionState = { open: false };

const closing = (state: AnnotationSelectionState) => (state.open ? { ...state, open: false } : state);

// Firefox can hold several ranges at once; a passage is exactly one.
function singleRange(selection: Selection | null): Range | undefined {
  if (!selection || selection.isCollapsed) return undefined;
  if (selection.rangeCount !== 1) return undefined;
  return selection.getRangeAt(0);
}

export function useAnnotationSelection(containerRef: RefObject<Element | null>, toolbarRef: RefObject<Element | null>) {
  const [state, setState] = useState<AnnotationSelectionState>(CLOSED);
  // Pinned while the person writes a note: focusing the note field collapses the page selection, and the
  // passage must survive that, so selection changes are ignored until the note is added or cancelled.
  const pinnedRef = useRef(false);
  const dismiss = () => {
    pinnedRef.current = false;
    setState(closing);
  };
  const pin = useCallback(() => {
    pinnedRef.current = true;
  }, []);

  useEffect(() => {
    let pressing = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (!pinnedRef.current) setState(closing);
    };

    const reportSelection = (pointerReleased: boolean) => {
      if (pinnedRef.current) return;
      const container = containerRef.current;
      const selection = document.getSelection();
      const range = singleRange(selection);
      if (!container || !selection || !range) return close();
      const part = findAnnotatablePart(container, range);
      if (!part || (part.extendsPastContent && !pointerReleased)) return close();
      if (part.extendsPastContent) clampSelection(selection, part);
      const text = normalizeAnnotationText(selection.toString());
      if (!text) return close();
      setState({ open: true, selection: { text, source: annotationSource(part), anchor: selectionAnchor(part) } });
    };

    const insideCard = (target: EventTarget | null) => target instanceof Node && Boolean(toolbarRef.current?.contains(target));
    // A press on the card itself pins the passage first, before focus moves and the page selection collapses.
    const onPointerDown = (event: PointerEvent) => {
      if (insideCard(event.target)) {
        pinnedRef.current = true;
        return;
      }
      pressing = true;
    };
    const endPress = () => {
      pressing = false;
    };
    // Read after the browser finishes the gesture: a click inside a selection collapses it only after release.
    const onPointerUp = (event: PointerEvent) => {
      if (insideCard(event.target)) return;
      pressing = false;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => reportSelection(true));
    };
    const onSelectionChange = () => {
      // Focus moving into the toolbar can collapse the selection it acts on.
      if (toolbarRef.current?.contains(document.activeElement)) return;
      if (pressing) close();
      else reportSelection(false);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', endPress, true);
    // macOS swallows the pointer release behind a context menu.
    document.addEventListener('contextmenu', endPress, true);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimeout(settleTimer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', endPress, true);
      document.removeEventListener('contextmenu', endPress, true);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [containerRef, toolbarRef]);

  return { open: state.open, selection: state.selection, dismiss, pin };
}
