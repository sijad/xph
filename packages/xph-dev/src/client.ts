/** Browser script the runtime loads on every page in development; it connects back to the dev server. */
export const client = `const events = new EventSource(new URL('events', import.meta.url));
let overlay;
function clear() {
  overlay?.remove();
  overlay = undefined;
}
// Hashed stylesheet URLs change with their content, so take the new set from a fresh render of this page.
// Same-origin stylesheets whose URL is unchanged may still be stale, so they are fetched again too.
async function swapStyles() {
  const response = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Status ' + response.status);
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  const selector = 'link[rel="stylesheet"][href]';
  const url = (link) => {
    const href = new URL(link.getAttribute('href'), location.href);
    href.searchParams.delete('xph-dev');
    return href.href;
  };
  const current = [...document.querySelectorAll(selector)];
  const wanted = [...next.querySelectorAll(selector)].map(url);
  const old = current.filter((link) => !wanted.includes(url(link)));
  const anchor = old[0];
  const loads = [];
  const insert = (href, before) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    if (before) before.before(link);
    else document.head.append(link);
    loads.push(new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = reject;
    }));
  };
  for (const href of wanted) {
    const existing = current.find((link) => url(link) === href);
    if (!existing) insert(href, anchor);
    else if (new URL(href).origin === location.origin) {
      const fresh = new URL(href);
      fresh.searchParams.set('xph-dev', Date.now());
      insert(fresh.href, existing);
      old.push(existing);
    }
  }
  await Promise.all(loads);
  for (const link of old) link.remove();
}
events.addEventListener('reload', () => location.reload());
events.addEventListener('styles', () => {
  clear();
  swapStyles().catch(() => location.reload());
});
events.addEventListener('ok', clear);
events.addEventListener('failed', (event) => {
  const message = JSON.parse(event.data);
  console.error('[xph] ' + message);
  clear();
  overlay = document.createElement('pre');
  overlay.textContent = message;
  overlay.title = 'Click to dismiss';
  overlay.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483647;max-height:50vh;overflow:auto;margin:0;padding:16px;background:#1e1e1e;color:#ff8080;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;border-top:3px solid #ff5555;cursor:pointer';
  overlay.onclick = clear;
  document.body.append(overlay);
});
`;
