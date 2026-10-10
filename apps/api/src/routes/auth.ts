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
import { oauthClaims, sign, signSession, verify, verifySession } from '../auth/signed';
import { createSession, endSession, resolveGoogleUser } from '../auth/signin';
import type { AppEnv } from '../env';
import { randomToken } from '../lib/b64';
import { ApiError } from '../lib/errors';
import { withD1Retry } from '../lib/retry';
import { defineRoute, publicRoute, type RouteTable } from '../perm/routes';

const OAUTH_COOKIE = 'maktab_oauth';
const OAUTH_TTL_SEC = 10 * 60;

export type AuthDeps = {
  jwks: JwksClient;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

const redirectUri = (c: Context<AppEnv>) => `${c.env.APP_ORIGIN}/api/auth/google/callback`;
const secure = (c: Context<AppEnv>) => c.env.APP_ORIGIN.startsWith('https://');
const loginError = (c: Context<AppEnv>, code: string) =>
  c.redirect(`${c.env.APP_ORIGIN}/login?error=${encodeURIComponent(code)}`, 302);

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
      if (claims) await endSession(c.get('db'), claims.sid);
      deleteCookie(c, name, { path: '/', secure: secure(c) });
      return c.json({ ok: true });
    },
  );
}
