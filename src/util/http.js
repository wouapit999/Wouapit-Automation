const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Fetch a page as a browser would, following redirects. Returns { url, status, html }. */
export async function fetchHtml(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,fr;q=0.8',
      ...headers,
    },
  });
  const html = await res.text();
  return { url: res.url || url, status: res.status, html };
}

export async function fetchJson(url, init = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { status: res.status, ok: res.ok, body };
}
