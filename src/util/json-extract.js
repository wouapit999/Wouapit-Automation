/**
 * Extract a balanced JSON object/array that starts at `startIndex` in `text`.
 * Handles strings and escapes; returns the raw substring or null.
 */
export function extractBalanced(text, startIndex) {
  const open = text[startIndex];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** Find `marker` (e.g. "window.runParams =") and parse the JSON that follows. */
export function extractJsonAfter(text, marker) {
  let from = 0;
  while (true) {
    const idx = text.indexOf(marker, from);
    if (idx === -1) return null;
    let i = idx + marker.length;
    while (i < text.length && /\s|=/.test(text[i])) i++;
    const raw = extractBalanced(text, i);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* try a looser parse below */ }
      try { return looseParse(raw); } catch { /* keep searching */ }
    }
    from = idx + marker.length;
  }
}

/** Some pages embed JS object literals (unquoted keys). Only used as a fallback. */
function looseParse(raw) {
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${raw});`)();
}

/** Parse all <script type="application/ld+json"> blocks. */
export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed); else out.push(parsed);
    } catch { /* ignore */ }
  }
  return out;
}

export function metaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return decodeEntities(m[1]);
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : null;
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Depth-first search for the first value under any of the given keys. */
export function deepFind(obj, keys, maxDepth = 12) {
  const want = new Set(keys);
  const seen = new Set();
  const stack = [[obj, 0]];
  while (stack.length) {
    const [cur, d] = stack.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur) || d > maxDepth) continue;
    seen.add(cur);
    if (!Array.isArray(cur)) {
      for (const k of Object.keys(cur)) if (want.has(k) && cur[k] !== null && cur[k] !== undefined && cur[k] !== '') return cur[k];
    }
    for (const v of Array.isArray(cur) ? cur : Object.values(cur)) if (v && typeof v === 'object') stack.push([v, d + 1]);
  }
  return undefined;
}

export function stripHtml(html) {
  return decodeEntities(String(html ?? '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function normalizeImageUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  // AliExpress/Alibaba thumbnails: strip size suffixes like _50x50.jpg, .jpg_.webp, _220x220q75.jpg_.avif
  s = s.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, '$1').replace(/_\d+x\d+(?:q\d+)?(?=\.(?:jpe?g|png|webp)$)/i, '');
  return /^https?:\/\//i.test(s) ? s : null;
}
