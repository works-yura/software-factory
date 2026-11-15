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
 * The page never scrolls sideways and no visible element ends past the viewport's right edge
 * (fixed overlays and elements inside a horizontal scroller excepted: those scroll on purpose).
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const scrollsSideways = (element: Element | null): boolean => {
      for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden' || style.overflowX === 'clip') && node.scrollWidth > node.clientWidth) return true;
        if (style.position === 'fixed') return true;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right <= viewport + 1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.position === 'fixed') continue;
      if (scrollsSideways(element)) continue;
      const label = (element.getAttribute('data-slot') ?? element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60);
      offenders.push(`<${element.tagName.toLowerCase()}> right=${Math.round(rect.right)} "${label}"`);
      if (offenders.length >= 8) break;
    }
    return { scrollWidth: document.documentElement.scrollWidth, viewport, offenders };
  });
  expect(result.offenders, `elements past the right edge (${result.viewport}px):\n${result.offenders.join('\n')}`).toEqual([]);
  expect(result.scrollWidth, 'document scrolls sideways').toBeLessThanOrEqual(result.viewport);
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
  await page.screenshot({ path: screenshotPath(testInfo, name), fullPage: true });
  if (unhandled.length > 0) {
    const calls = [...new Set(unhandled)].join(', ');
    testInfo.annotations.push({ type: 'unmocked', description: calls });
    console.warn(`[layout] ${name}: unmocked ${calls}`);
  }
  await expectNoHorizontalOverflow(page);
}
