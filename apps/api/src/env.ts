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
  /** The only address that may claim an empty installation as owner (PLAN §14.1). Empty = nobody. */
  OWNER_EMAIL?: string;
};

export type Variables = {
  db: AppDb;
  /** undefined = not looked up yet; null = anonymous. */
  principal: Principal | null | undefined;
  /** The grant the permission guard resolved, for row-scope helpers. */
  grant: Grant;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
