import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { getResponse } from 'msw';
import type { RequestHandler } from 'msw';
import path from 'node:path';

import { server } from '../ui/msw-server';

/**
 * Answers the page's API calls (`/web`, `/auth`, `/api`) with MSW handlers in this process: the ones
 * given first, then the UI suite's ambient ones (`e2e/ui/msw-server.ts`). A call nobody answers gets a
 * 404 and is returned in `unhandled`, so a test can show what its page still reads unmocked.
 */
export async function mockApi(page: Page, handlers: RequestHandler[]): Promise<{ unhandled: string[] }> {
  const all = [...handlers, ...server.listHandlers()];
  const unhandled: string[] = [];
  await page.route(
    url => /^\/(web|auth|api)\//.test(url.pathname),
    async route => {
      const request = route.request();
      if ((request.headers().accept ?? '').includes('text/event-stream')) {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
        return;
      }
      const body = request.postDataBuffer();
      const response = await getResponse(
        all,
        new Request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          ...(body && request.method() !== 'GET' && request.method() !== 'HEAD' ? { body } : {}),
        }),
      );
      if (!response) {
        unhandled.push(`${request.method()} ${new URL(request.url()).pathname}`);
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_mocked"}' });
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    },
  );
  return { unhandled };
}

/** Where a page's screenshot goes: `<LAYOUT_OUTPUT>/<project>/<name>.png`. */
export function screenshotPath(testInfo: TestInfo, name: string): string {
  const root = (testInfo.config.metadata as { screenshots?: string }).screenshots ?? 'test-results/layout';
  return path.join(root, testInfo.project.name, `${name}.png`);
}

/**
 * The page never scrolls sideways: the document is no wider than the viewport, no visible element
 * ends past the viewport's right edge, and no inner scroller (the settings pane, a card) scrolls
 * sideways either. Fixed overlays are left out; so are scrollers that scroll sideways on purpose
 * (`pre`, code views, tab strips, anything marked `data-scroll-x`, and tables below 640 px).
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const describe = (element: Element) => {
      const label = (element.getAttribute('data-slot') ?? element.getAttribute('aria-label') ?? element.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);
      return `<${element.tagName.toLowerCase()} class="${element.className.toString().slice(0, 60)}"> "${label}"`;
    };
    // Tab strips scroll on purpose; a table may scroll sideways on a phone, never wider.
    const intendedSelector = [
      'pre',
      '.cm-editor',
      '[data-scroll-x]',
      '[data-slot="tabs-list-scroll"]',
      ...(viewport < 640 ? ['table', '[role="table"]', '[role="grid"]', '[data-slot="table-scroll"]'] : []),
    ].join(', ');
    const intended = (element: Element) => element.closest(intendedSelector) !== null;
    const inFixed = (element: Element) => {
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') return true;
      }
      return false;
    };
    // Text cut with an ellipsis (`truncate`) may run past its box on purpose; anything else a
    // clipping ancestor hides past the viewport's edge is content the person cannot reach.
    const ellipsized = (element: Element) => {
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'hidden' || style.overflowX === 'clip') return style.textOverflow === 'ellipsis';
      }
      return false;
    };
    const pastEdge: string[] = [];
    const sideways: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (inFixed(element) || intended(element)) continue;
      if (rect.right > viewport + 1 && !ellipsized(element) && pastEdge.length < 8) {
        pastEdge.push(`${describe(element)} right=${Math.round(rect.right)}`);
      }
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        element.scrollWidth > element.clientWidth + 1 &&
        sideways.length < 8
      ) {
        sideways.push(`${describe(element)} scrollWidth=${element.scrollWidth} clientWidth=${element.clientWidth}`);
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, viewport, pastEdge, sideways };
  });
  expect(result.pastEdge, `elements past the right edge (${result.viewport}px):\n${result.pastEdge.join('\n')}`).toEqual([]);
  expect(result.sideways, `inner scrollers that scroll sideways:\n${result.sideways.join('\n')}`).toEqual([]);
  expect(result.scrollWidth, 'document scrolls sideways').toBeLessThanOrEqual(result.viewport);
}

/**
 * A screenshot of the whole page: the app scrolls inside its own pane (not the document), so the
 * viewport is made as tall as the tallest vertical scroller's content first, then put back.
 */
async function screenshotWhole(page: Page, file: string): Promise<void> {
  const viewport = page.viewportSize();
  const extra = await page.evaluate(() => {
    let most = 0;
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const overflow = getComputedStyle(element).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight) {
        most = Math.max(most, element.scrollHeight - element.clientHeight);
      }
    }
    return most;
  });
  if (viewport && extra > 0) await page.setViewportSize({ width: viewport.width, height: Math.min(viewport.height + extra, 12_000) });
  await page.screenshot({ path: file, fullPage: true });
  if (viewport && extra > 0) await page.setViewportSize(viewport);
}

/**
 * Visible buttons, links and form controls smaller than 40×40 px on a touch screen (both sides
 * counted with the element's own hit area). Returned, not asserted: the design system's small
 * controls are 28 px everywhere, so this is reported per page.
 */
export async function smallTouchTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="combobox"], input, select')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 40 || rect.height < 40) && getComputedStyle(element).visibility !== 'hidden';
      })
      .map(element => (element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).trim().slice(0, 40)),
  );
}

/**
 * Opens `url` with the API answered by `handlers`, waits for it to settle, screenshots it as
 * `name`, and checks it never pushes sideways. Calls nobody mocked are noted on the test.
 */
export async function checkPage(
  page: Page,
  testInfo: TestInfo,
  { url, name, handlers }: { url: string; name: string; handlers: RequestHandler[] },
): Promise<void> {
  const { unhandled } = await mockApi(page, handlers);
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  // Skeletons and fade-ins settle before the picture is taken.
  await page.waitForTimeout(300);
  await screenshotWhole(page, screenshotPath(testInfo, name));
  if (unhandled.length > 0) {
    const calls = [...new Set(unhandled)].join(', ');
    testInfo.annotations.push({ type: 'unmocked', description: calls });
    console.warn(`[layout] ${name}: unmocked ${calls}`);
  }
  await expectNoHorizontalOverflow(page);
}
