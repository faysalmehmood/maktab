import { newId } from '@maktab/shared';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  exchangeCode,
  googleAuthUrl,
  IdTokenError,
  type JwksClient,
  verifyIdToken,
} from '../auth/google';
import { nowSec, SESSION_TTL_SEC, sessionCookieName } from '../auth/principal';
import {
  oauthClaims,
  sign,
  signSession,
  verify,
  verifyLogout,
  verifySession,
} from '../auth/signed';
import { createSession, endSession, resolveGoogleUser } from '../auth/signin';
import type { AppEnv } from '../env';
import { randomToken } from '../lib/b64';
import { ApiError } from '../lib/errors';
import { withD1Retry } from '../lib/retry';
import { clientIp, TURNSTILE_SCRIPT, turnstileSiteKey, verifyTurnstile } from '../lib/turnstile';
import { defineRoute, publicRoute, type RouteTable } from '../perm/routes';

const OAUTH_COOKIE = 'maktab_oauth';
/**
 * Set by the web app (not HttpOnly) when a sign-out could not reach the server: it carries the old
 * session's logout token, and the OAuth callback revokes that session before the new one starts.
 */
export const LOGOUT_PENDING_COOKIE = 'maktab_logout_pending';
const OAUTH_TTL_SEC = 10 * 60;

export type AuthDeps = {
  jwks: JwksClient;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

const redirectUri = (c: Context<AppEnv>) => `${c.env.APP_ORIGIN}/api/auth/google/callback`;
const secure = (c: Context<AppEnv>) => c.env.APP_ORIGIN.startsWith('https://');
const loginError = (c: Context<AppEnv>, code: string) =>
  c.redirect(`${c.env.APP_ORIGIN}/login?error=${encodeURIComponent(code)}`, 302);

/**
 * The pre-check page in front of Google sign-in: Turnstile's widget, then straight on to
 * /api/auth/google/start?ts=<token>. Its own strict CSP (a nonce for the one inline script, the
 * Turnstile origin for its script and frame); bilingual, no app bundle.
 */
function turnstilePage(c: Context<AppEnv>, siteKey: string): Response {
  const nonce = randomToken();
  const origin = new URL(TURNSTILE_SCRIPT).origin;
  const esc = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Maktab — sign in</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0 16px;text-align:center;color:#111}p{margin:.5rem 0}</style>
</head><body><main><p>Checking this is a person, then on to Google…</p>
<p lang="ur" dir="rtl">تصدیق کے بعد گوگل سائن اِن کھلے گا…</p>
<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-callback="maktabGo"></div>
<noscript>JavaScript is needed to sign in.</noscript></main>
<script nonce="${nonce}">function maktabGo(t){location.replace('/api/auth/google/start?ts='+encodeURIComponent(t))}</script>
<script nonce="${nonce}" src="${TURNSTILE_SCRIPT}" async defer></script>
</body></html>`;
  return c.html(html, 200, {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' ${origin}; frame-src ${origin}; connect-src ${origin}; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
}

export function authRoutes(app: Hono<AppEnv>, table: RouteTable, deps: AuthDeps): void {
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/auth/google/start', access: publicRoute },
    async (c) => {
      // Without a client id Google shows a confusing error page; fail loudly here instead.
      if (!c.env.GOOGLE_CLIENT_ID?.trim()) {
        throw new ApiError(500, 'misconfigured', 'GOOGLE_CLIENT_ID is not set');
      }
      // Turnstile on (M7): first a one-click check page, which comes back here with ?ts=<token>.
      const siteKey = turnstileSiteKey(c.env);
      if (siteKey) {
        const ts = c.req.query('ts');
        if (!ts) return turnstilePage(c, siteKey);
        if (
          !(await verifyTurnstile(
            c.env,
            deps.fetch,
            ts,
            clientIp((h) => c.req.header(h)),
            'open',
          ))
        )
          return loginError(c, 'turnstile_failed');
      }
      const state = randomToken();
      const nonce = randomToken();
      const cookie = await sign(c.env.SESSION_SECRET, {
        typ: 'oauth',
        state,
        nonce,
        exp: nowSec() + OAUTH_TTL_SEC,
      });
      // Lax, not Strict: the browser must send it on the top-level redirect back from Google.
      setCookie(c, OAUTH_COOKIE, cookie, {
        httpOnly: true,
        secure: secure(c),
        sameSite: 'Lax',
        path: '/api/auth',
        maxAge: OAUTH_TTL_SEC,
      });
      return c.redirect(
        googleAuthUrl({
          clientId: c.env.GOOGLE_CLIENT_ID,
          redirectUri: redirectUri(c),
          state,
          nonce,
        }),
        302,
      );
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/auth/google/callback', access: publicRoute },
    async (c) => {
      const saved = await verify(
        c.env.SESSION_SECRET,
        getCookie(c, OAUTH_COOKIE),
        'oauth',
        oauthClaims,
        nowSec(),
      );
      deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth', secure: secure(c) });
      // A sign-out queued offline on this phone: end exactly that old session now, whatever happens
      // to this sign-in. On a D1 error the cookie stays and the app's own retry sends it later.
      const pending = await verifyLogout(
        c.env.SESSION_SECRET,
        getCookie(c, LOGOUT_PENDING_COOKIE),
        nowSec(),
      );
      if (pending) {
        try {
          await withD1Retry(() => endSession(c.get('db'), pending.sid));
          deleteCookie(c, LOGOUT_PENDING_COOKIE, { path: '/', secure: secure(c) });
        } catch (err) {
          console.warn('pending logout not revoked at sign-in:', err);
        }
      } else if (getCookie(c, LOGOUT_PENDING_COOKIE) !== undefined)
        deleteCookie(c, LOGOUT_PENDING_COOKIE, { path: '/', secure: secure(c) });
      if (c.req.query('error')) return loginError(c, 'denied');
      const code = c.req.query('code');
      // State binds the callback to the browser that started the flow (login CSRF).
      if (!saved || !code || c.req.query('state') !== saved.state)
        return loginError(c, 'invalid_state');
      try {
        const idToken = await exchangeCode(
          {
            code,
            clientId: c.env.GOOGLE_CLIENT_ID,
            clientSecret: c.env.GOOGLE_CLIENT_SECRET,
            redirectUri: redirectUri(c),
          },
          deps.fetch,
        );
        const claims = await verifyIdToken(idToken, {
          jwks: deps.jwks,
          audience: c.env.GOOGLE_CLIENT_ID,
          nonce: saved.nonce,
          nowSec: nowSec(),
        });
        const db = c.get('db');
        // Ids are minted outside the retry so a retried write is the same write (lib/retry.ts).
        const newUserId = newId();
        const sessionId = newId();
        const u = await withD1Retry(() =>
          resolveGoogleUser(db, claims, { ownerEmail: c.env.OWNER_EMAIL, newUserId }),
        );
        const s = await withD1Retry(() =>
          createSession(db, sessionId, u.id, {
            ua: c.req.header('user-agent') ?? null,
            ip: c.req.header('cf-connecting-ip') ?? null,
            nowMs: Date.now(),
          }),
        );
        setCookie(
          c,
          sessionCookieName(c.env.APP_ORIGIN),
          await signSession(c.env.SESSION_SECRET, s.id, s.exp),
          {
            httpOnly: true,
            secure: secure(c),
            sameSite: 'Lax',
            path: '/',
            maxAge: SESSION_TTL_SEC,
          },
        );
        return c.redirect(`${c.env.APP_ORIGIN}/`, 302);
      } catch (err) {
        if (err instanceof ApiError) return loginError(c, err.code);
        if (err instanceof IdTokenError) {
          console.warn('id token rejected:', err.message);
          return loginError(c, 'invalid_token');
        }
        throw err;
      }
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/auth/logout', access: publicRoute },
    async (c) => {
      const name = sessionCookieName(c.env.APP_ORIGIN);
      const claims = await verifySession(c.env.SESSION_SECRET, getCookie(c, name), nowSec());
      // `{logout_token}` (M7a): revoke exactly the session it names — a sign-out queued offline and
      // sent after someone else signed in on this phone must not end the new session. Idempotent;
      // a bad or expired token revokes nothing (an expired one's session has expired too).
      let body: unknown = null;
      try {
        const text = await c.req.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new ApiError(400, 'invalid', 'Body must be JSON');
      }
      const raw =
        body && typeof body === 'object' && 'logout_token' in body
          ? (body as { logout_token: unknown }).logout_token
          : undefined;
      if (raw !== undefined) {
        if (typeof raw !== 'string' || raw.length > 1024)
          throw new ApiError(400, 'invalid', 'logout_token: must be a string');
        const target = await verifyLogout(c.env.SESSION_SECRET, raw, nowSec());
        if (target) await endSession(c.get('db'), target.sid);
        // The cookie goes only when it belongs to the session just ended.
        if (claims && target && claims.sid === target.sid)
          deleteCookie(c, name, { path: '/', secure: secure(c) });
        return c.json({ ok: true, revoked: !!target });
      }
      if (claims) await endSession(c.get('db'), claims.sid);
      deleteCookie(c, name, { path: '/', secure: secure(c) });
      return c.json({ ok: true, revoked: !!claims });
    },
  );
}
