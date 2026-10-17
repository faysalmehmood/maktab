import { BlockList, isIP } from 'node:net';

/**
 * Which TCP peers may tell us the client's IP (self-hosted server, docs/self-host.md §5).
 *
 * `TRUST_PROXY_FROM` is a comma/space separated list of IPs or CIDRs (`172.16.0.0/12`,
 * `10.0.0.5`, `fd00::/8`). Empty = nobody: the client IP is always the socket peer. When the
 * peer is inside the list, its `CF-Connecting-IP` header (set by cloudflared) is the client IP, if
 * it is exactly one valid IP; anything else falls back to the peer. X-Forwarded-For is never read.
 * The value is used only for rate limits, the parent access log and Turnstile's remoteip.
 */
export type TrustedProxies = { list: BlockList; entries: string[] };

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`, how Node reports v4 peers on a dual-stack socket) → v4. */
export const normIp = (ip: string | undefined | null): string | undefined => {
  const v = ip?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return v && isIP(v) ? v : undefined;
};

/** Strict parse; throws (with the bad entry) on anything that is not an IP or IP/prefix. */
export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  const list = new BlockList();
  const entries: string[] = [];
  for (const raw of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^([0-9A-Fa-f:.]+)(?:\/(\d{1,3}))?$/.exec(raw);
    const addr = m?.[1] ?? '';
    const v = isIP(addr);
    if (!m || !v) throw new Error(`TRUST_PROXY_FROM: not an IP or CIDR: ${JSON.stringify(raw)}`);
    const max = v === 4 ? 32 : 128;
    const prefix = m[2] === undefined ? max : Number(m[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max)
      throw new Error(`TRUST_PROXY_FROM: bad prefix length in ${JSON.stringify(raw)}`);
    list.addSubnet(addr, prefix, v === 4 ? 'ipv4' : 'ipv6');
    entries.push(`${addr}/${prefix}`);
  }
  return { list, entries };
}

export function isTrusted(t: TrustedProxies, peer: string | undefined): boolean {
  const ip = normIp(peer);
  if (!ip || !t.entries.length) return false;
  return t.list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

/** The client IP for this request: the trusted proxy's CF-Connecting-IP, else the socket peer. */
export function chooseClientIp(
  headers: Headers,
  peer: string | undefined,
  trusted: TrustedProxies,
): string | undefined {
  if (isTrusted(trusted, peer)) {
    const cf = headers.get('cf-connecting-ip');
    // Exactly one address: "a, b" or junk is not a client IP.
    const ip = cf && !cf.includes(',') ? normIp(cf) : undefined;
    if (ip) return ip;
  }
  return normIp(peer);
}

/** 127.0.0.0/8 or ::1: a request from inside the container (the HEALTHCHECK, docker exec). */
export const isLoopback = (peer: string | undefined): boolean => {
  const ip = normIp(peer);
  return !!ip && (ip === '::1' || /^127\./.test(ip));
};
