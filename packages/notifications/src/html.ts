/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Only http(s) links go into an email; anything else (javascript:, data:) is refused. */
export function safeLink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Refusing a ${url.protocol} link in a notification.`);
  return url.toString();
}

export interface EmailLayout {
  heading: string;
  paragraphs: readonly string[];
  action: { label: string; url: string };
  footer: string;
}

/** One plain, inline-styled layout every email shares: heading, text, one button, a footer. */
export function renderEmailHtml({ heading, paragraphs, action, footer }: EmailLayout): string {
  const url = escapeHtml(safeLink(action.url));
  const body = paragraphs.map(text => `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`).join('');
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">',
    `<h1 style="margin:0 0 20px;font-size:20px;font-weight:600">${escapeHtml(heading)}</h1>`,
    body,
    `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(action.label)}</a></p>`,
    `<p style="margin:0 0 8px;font-size:13px;color:#78716c">${escapeHtml(url)}</p>`,
    `<p style="margin:24px 0 0;font-size:12px;color:#a8a29e">${escapeHtml(footer)}</p>`,
    '</div></body></html>',
  ].join('');
}
