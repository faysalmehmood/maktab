import type { AppDb } from '@maktab/db';
import type { Grant } from '@maktab/shared';
import type { Principal } from './auth/principal';

export type Bindings = {
  DB: D1Database;
  /** Student photos and the school logo. Unbound → upload routes answer 501 `no_storage`. */
  FILES?: R2Bucket;
  ASSETS?: Fetcher;
  /** The nightly encrypted dumps (R2 `maktab-backups`); read-only use: the backup page lists them. */
  BACKUPS?: R2Bucket;
  /**
   * Shared with the GitHub Actions backup workflows (>= 32 chars): POST /api/backup/runs needs it as
   * a Bearer token. Unset → that route answers 503 and the backup page says reporting is off.
   */
  BACKUP_REPORT_TOKEN?: string;
  SESSION_SECRET: string;
  /**
   * Parent links (M5): link tokens, gate tokens, PIN and access-log IP hashes are HMACs under this
   * secret (>= 32 chars), never SESSION_SECRET. A restore needs the same value or every link stops
   * working; changing it is how all links are revoked at once (then POST /api/parent-links/rotate-all).
   */
  PARENT_LINK_SECRET?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_ORIGIN: string;
  /**
   * Cloudflare Turnstile (M7, optional). Both set → the parent gate needs a Turnstile token and Google
   * sign-in starts with a one-click check page; either unset → no Turnstile anywhere (docs/deploy.md).
   */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** The only address that may claim an empty installation as owner (PLAN §14.1). Empty = nobody. */
  OWNER_EMAIL?: string;
  /**
   * "1" = this installation is the public demo (docs/demo.md): demo sign-in buttons, the banner,
   * locked installation settings, capped uploads and the nightly reset. Never set on a real school's
   * Worker (apps/api/test/demo.test.ts checks wrangler.toml).
   */
  DEMO_MODE?: string;
};

export type Variables = {
  db: AppDb;
  /** undefined = not looked up yet; null = anonymous. */
  principal: Principal | null | undefined;
  /** The grant the permission guard resolved, for row-scope helpers. */
  grant: Grant;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
