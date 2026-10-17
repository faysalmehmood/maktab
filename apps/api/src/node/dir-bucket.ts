import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * The part of the R2 bucket API Maktab uses (lib/files.ts, routes/people|catalog|money|parent|backup),
 * on a local directory: `put`, `get` (body + httpMetadata), `head`, `delete`, `list` (prefix, limit).
 * Self-hosted only (docs/self-host.md); wired as FILES (`DATA_DIR/files`) and BACKUPS
 * (`DATA_DIR/backups`).
 *
 * - Keys are R2-style paths (`students/<id>/<id>`). Each segment must be a plain name: no `..` or
 *   `.`, nothing starting with a dot, no backslash, NUL or control characters, no empty segment,
 *   no leading `/`. Anything else is refused (an Error), never normalised, so a key can never resolve
 *   outside the root.
 * - The content type (and custom metadata) live in a sidecar `.<name>.meta` next to the object. A
 *   dot-name can never be a key, so a sidecar never collides with an object and `list` skips it.
 * - Writes are atomic: a dot-named temp file in the same directory, fsync'd, then renamed over the
 *   target. A crash leaves the old object or the new one, never half of one (a stray temp file at
 *   worst, which `list` ignores).
 */

export type DirObject = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  httpEtag: string;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
};

export type DirObjectBody = DirObject & {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
};

type PutValue = ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream | null;
type PutOptions = {
  httpMetadata?: { contentType?: string } | Headers;
  customMetadata?: Record<string, string>;
};
type Meta = { contentType?: string; customMetadata?: Record<string, string> };

const MAX_KEY = 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`invalid object key ${JSON.stringify(key.slice(0, 80))}`);
    this.name = 'InvalidKeyError';
  }
}

/** The segments of a valid key; throws InvalidKeyError otherwise. */
export function keySegments(key: string): string[] {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY || BAD_CHARS.test(key))
    throw new InvalidKeyError(String(key));
  const parts = key.split('/');
  for (const p of parts)
    if (!p || p === '.' || p === '..' || p.startsWith('.')) throw new InvalidKeyError(key);
  return parts;
}

/** A list prefix may end in `/` (a "folder") or part-way through a name; the same rules otherwise. */
function prefixSegments(prefix: string): { dir: string[]; partial: string } {
  if (!prefix) return { dir: [], partial: '' };
  if (BAD_CHARS.test(prefix) || prefix.length > MAX_KEY || prefix.startsWith('/'))
    throw new InvalidKeyError(prefix);
  const parts = prefix.split('/');
  const partial = parts.pop() ?? '';
  for (const p of parts)
    if (!p || p === '.' || p === '..' || p.startsWith('.')) throw new InvalidKeyError(prefix);
  if (partial.startsWith('.')) throw new InvalidKeyError(prefix);
  return { dir: parts, partial };
}

async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

const isMissing = (err: unknown) =>
  (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (err as NodeJS.ErrnoException)?.code === 'ENOTDIR';

export class DirBucket {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Absolute path of a key, checked to stay under the root (belt and braces after keySegments). */
  pathOf(key: string): string {
    const p = resolve(this.root, ...keySegments(key));
    const rel = relative(this.root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new InvalidKeyError(key);
    return p;
  }

  private metaPath(file: string): string {
    return join(dirname(file), `.${basename(file)}.meta`);
  }

  private async writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    const tmp = join(dirname(file), `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flush: true });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async put(key: string, value: PutValue, options: PutOptions = {}): Promise<DirObject> {
    const file = this.pathOf(key);
    const bytes = await toBytes(value);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const hm = options.httpMetadata;
    const contentType =
      hm instanceof Headers ? (hm.get('content-type') ?? undefined) : hm?.contentType;
    const meta: Meta = {};
    if (contentType) meta.contentType = contentType;
    if (options.customMetadata && Object.keys(options.customMetadata).length)
      meta.customMetadata = options.customMetadata;
    // Sidecar first: an object is never visible with a stale type from an earlier put.
    if (Object.keys(meta).length)
      await this.writeAtomic(this.metaPath(file), new TextEncoder().encode(JSON.stringify(meta)));
    else await rm(this.metaPath(file), { force: true });
    await this.writeAtomic(file, bytes);
    const info = await this.head(key);
    if (!info) throw new Error(`put ${key}: object vanished`);
    return info;
  }

  async head(key: string): Promise<DirObject | null> {
    const file = this.pathOf(key);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      // lstat: a symlink is never an object (nothing here makes one; refuse to follow one).
      st = await lstat(file);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (!st.isFile()) return null;
    let meta: Meta = {};
    try {
      meta = JSON.parse(await readFile(this.metaPath(file), 'utf8')) as Meta;
    } catch {
      // No sidecar (or unreadable): no declared type, as for an R2 object put without one.
    }
    const etag = `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`;
    return {
      key,
      size: st.size,
      uploaded: st.mtime,
      etag,
      httpEtag: `"${etag}"`,
      httpMetadata: meta.contentType ? { contentType: meta.contentType } : {},
      customMetadata: meta.customMetadata ?? {},
    };
  }

  async get(key: string): Promise<DirObjectBody | null> {
    const info = await this.head(key);
    if (!info) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await readFile(this.pathOf(key)));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    return {
      ...info,
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const file = this.pathOf(key);
      await rm(file, { force: true });
      await rm(this.metaPath(file), { force: true });
    }
  }

  /**
   * Objects under `prefix`, sorted by key like R2, at most `limit` (default 1000). Only `prefix` and
   * `limit` are supported (no delimiter or cursor: the callers never use them); `truncated` says
   * whether more exist.
   */
  async list(
    options: { prefix?: string; limit?: number } = {},
  ): Promise<{ objects: DirObject[]; truncated: boolean; delimitedPrefixes: string[] }> {
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
    const { dir, partial } = prefixSegments(options.prefix ?? '');
    const start = resolve(this.root, ...dir);
    const keys: string[] = [];
    const walk = async (abs: string, rel: string[]) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      for (const e of entries) {
        // Sidecars, temp files and anything else dot-named are never objects.
        if (e.name.startsWith('.')) continue;
        if (rel.length === dir.length && !e.name.startsWith(partial)) continue;
        if (e.isDirectory()) await walk(join(abs, e.name), [...rel, e.name]);
        else if (e.isFile()) keys.push([...rel, e.name].join('/'));
      }
    };
    await walk(start, dir);
    keys.sort();
    const objects: DirObject[] = [];
    for (const key of keys.slice(0, limit)) {
      const o = await this.head(key);
      if (o) objects.push(o);
    }
    return { objects, truncated: keys.length > limit, delimitedPrefixes: [] };
  }
}
