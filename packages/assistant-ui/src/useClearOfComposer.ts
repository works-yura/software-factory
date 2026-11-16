import { useEffect, useState } from 'react';

/** The gap the floating button keeps from the screen edges and from a composer under it. */
const EDGE = 16;
const GAP = 8;

/**
 * How far from the bottom the floating button sits so it never covers a chat composer (its send and
 * stop buttons sit in the same corner on a phone): the default edge gap, or just above the composer
 * when that (with the notices above its box) reaches under the button. Undefined until there is a composer to clear.
 */
export function useClearOfComposer(button: HTMLElement | null): number | undefined {
  const [bottom, setBottom] = useState<number>();

  useEffect(() => {
    if (!button) return;
    let frame = 0;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(() => schedule());

    function measure() {
      frame = 0;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const size = button!.offsetWidth || 40;
      const left = width - EDGE - size - GAP;
      const top = height - EDGE - size - GAP;
      let lift: number | undefined;
      // The composer's form holds its notices (a reconnecting strip) above the box; the box is as wide as it gets.
      for (const form of document.querySelectorAll('[data-slot="composer"]')) {
        const box = form.querySelector('[data-slot="composer-box"]');
        if (!box) continue;
        if (!observed.has(form)) {
          observed.add(form);
          resize.observe(form);
        }
        const wide = box.getBoundingClientRect();
        const tall = form.getBoundingClientRect();
        const rectTop = Math.min(wide.top, tall.top);
        if (wide.width === 0 || wide.right <= left || wide.bottom <= top || rectTop >= height) continue;
        lift = Math.max(lift ?? 0, height - rectTop + GAP);
      }
      setBottom(lift);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    // A composer comes and goes with the page: look again when the page changes, cheaply, once a frame.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [button]);

  return bottom;
}
