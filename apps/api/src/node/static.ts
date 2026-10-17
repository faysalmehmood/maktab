import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Workers Static Assets, re-done for the self-hosted server (apps/api/src/node.ts) so the built web
 * app behaves the same as on Cloudflare (apps/api/wrangler.toml [assets]):
 *
 * - `run_worker_first` paths never reach here (the server sends them to the Hono app first).
 * - A request for an existing file gets it, with the rules of `apps/web/public/_headers` applied
 *   (parsed from the built `dist/_headers`; the rules are never copied into code). `_headers` and
 *   `_redirects` themselves are never served, nor is any dot-file.
 * - html_handling "auto-trailing-slash" (the Workers default): `/x` serves `x.html` or `x/index.html`;
 *   `/index.html` and `/x.html` redirect (307) to `/` and `/x`.
 * - not_found_handling "single-page-application": an unknown path answers `index.html` (200) to a
 *   browser navigation (`Sec-Fetch-Mode: navigate`, or no Sec-Fetch-Mode and `Accept: text/html`);
 *   any other unknown request goes to the app, which answers its JSON 404, as on Workers with
 *   `assets_navigation_prefers_asset_serving` (on for this compatibility date).
 * - Caching: content-hashed files under `/assets/` are `public, max-age=31536000, immutable`; every
 *   other file `public, max-age=0, must-revalidate` (the Workers default) with an ETag, so a new
 *   deploy is picked up on the next load. `If-None-Match` answers 304.
 * - No directory listing, ever: a directory without index.html is "not found".
 */

export type HeaderRule = {
  pattern: string;
  regex: RegExp;
  set: [string, string][];
  detach: string[];
};

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Cloudflare's `_headers` syntax: a path line, then indented `Name: value` / `! Name` lines; `#` comments. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (!indented) {
      // Only path patterns: an absolute-URL rule (`https://host/…`) names a host, and this server
      // has one origin; such a rule is skipped (with its header lines) rather than misapplied.
      if (!line.startsWith('/')) {
        current = null;
        continue;
      }
      const pattern = line;
      const body = pattern
        .split('*')
        .map((part) => escapeRe(part).replace(/:[A-Za-z]\w*/g, '[^/]+'))
        .join('.*');
      current = { pattern, regex: new RegExp(`^${body}$`), set: [], detach: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('!')) {
      const name = line.slice(1).trim().toLowerCase();
      if (name) current.detach.push(name);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    // A header name is a token; anything else (a stray line) is ignored, never sent.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) continue;
    current.set.push([name, value]);
  }
  return rules;
}

/**
 * The headers every matching rule adds, in file order: the same header from two rules is joined with
 * ", " (as Cloudflare does); `! Name` in a matching rule removes it.
 */
export function headersFor(rules: readonly HeaderRule[], path: string): Headers {
  const out = new Headers();
  const detached = new Set<string>();
  for (const r of rules) {
    if (!r.regex.test(path)) continue;
    for (const [k, v] of r.set) {
      const prev = out.get(k);
      out.set(k, prev ? `${prev}, ${v}` : v);
    }
    for (const d of r.detach) detached.add(d);
  }
  for (const d of detached) out.delete(d);
  return out;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

export const contentTypeOf = (file: string) =>
  TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Vite's content-hashed output (`/assets/name-AbCd1234.js`): safe to cache forever. */
export const isHashedAsset = (path: string) =>
  path.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path);

const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export type StaticHandler = {
  /** null = not an asset and not a navigation: the caller hands the request to the app. */
  serve: (req: Request) => Promise<Response | null>;
  /** The SPA shell (`/`), for the ASSETS binding the parent page fetches. */
  index: (req: Request) => Promise<Response>;
  rules: HeaderRule[];
};

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = resolve(rootDir);
  let rules: HeaderRule[] = [];
  try {
    rules = parseHeadersFile(readFileSync(join(root, '_headers'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    console.warn(
      `[maktab] no _headers in ${root}: static files are served without the SPA headers`,
    );
  }

  /** A regular file inside root for this URL path, or null. Never a directory, never outside root. */
  const fileAt = async (
    urlPath: string,
  ): Promise<{ file: string; size: number; mtimeMs: number } | null> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const segments = decoded.split('/').filter(Boolean);
    // Dot-files and dot-dirs (and so `..`) are never served; nor the Workers config files.
    if (segments.some((s) => s.startsWith('.'))) return null;
    if (segments.length === 1 && (segments[0] === '_headers' || segments[0] === '_redirects'))
      return null;
    const file = resolve(root, ...segments);
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    try {
      const st = await stat(file);
      return st.isFile() ? { file, size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null;
    }
  };

  const respond = async (
    req: Request,
    urlPath: string,
    found: { file: string; size: number; mtimeMs: number },
  ): Promise<Response> => {
    const headers = new Headers({
      'content-type': contentTypeOf(found.file),
      'cache-control': isHashedAsset(urlPath) ? IMMUTABLE : REVALIDATE,
    });
    const etag = `"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
    headers.set('etag', etag);
    // _headers wins over the defaults above, as on Workers (a rule may set Cache-Control).
    for (const [k, v] of headersFor(rules, urlPath)) headers.set(k, v);
    const inm = req.headers.get('if-none-match');
    if (inm?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag))
      return new Response(null, { status: 304, headers });
    headers.set('content-length', String(found.size));
    const body = req.method === 'HEAD' ? null : new Uint8Array(await readFile(found.file));
    return new Response(body, { status: 200, headers });
  };

  const redirect = (req: Request, to: string) => {
    const u = new URL(req.url);
    return new Response(null, { status: 307, headers: { location: `${to}${u.search}` } });
  };

  const index = async (req: Request): Promise<Response> => {
    const found = await fileAt('/index.html');
    if (!found) return new Response('Not found', { status: 404 });
    // Headers of the path asked for (the rules match the URL, not the file).
    return respond(req, new URL(req.url).pathname, found);
  };

  const isNavigation = (req: Request) => {
    const mode = req.headers.get('sec-fetch-mode');
    if (mode) return mode === 'navigate';
    return (req.headers.get('accept') ?? '').includes('text/html');
  };

  const serve = async (req: Request): Promise<Response | null> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const path = new URL(req.url).pathname;
    // auto-trailing-slash: the canonical URL of an HTML file has no `.html` / `index.html`.
    if (path.endsWith('/index.html')) {
      if (await fileAt(path)) return redirect(req, path.slice(0, -'index.html'.length));
    } else if (path.endsWith('.html') && (await fileAt(path))) {
      return redirect(req, path.slice(0, -'.html'.length));
    }
    if (path.endsWith('/')) {
      const found = await fileAt(`${path}index.html`);
      if (found) return respond(req, path, found);
    } else {
      const exact = await fileAt(path);
      if (exact && !path.endsWith('.html')) return respond(req, path, exact);
      const html = await fileAt(`${path}.html`);
      if (html) return respond(req, path, html);
      if (await fileAt(`${path}/index.html`)) return redirect(req, `${path}/`);
    }
    if (isNavigation(req)) return index(req);
    return null;
  };

  return { serve, index, rules };
}
