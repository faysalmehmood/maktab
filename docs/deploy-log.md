# Deploy log: first production deploy (2026-10-10)

Account: Faysalmehmood@hotmail.com's Account (`c2cb545de480a9e59b9e0d75d555c56f`), wrangler 4.149.0.
Host: https://maktab.conceptlix.com (custom domain, zone conceptlix.com on this account; NS koa/sarah.ns.cloudflare.com).

## Resources
- D1 `maktab`, id `440d652e-46bc-4389-88cc-b9a9fccffc44` (region EEUR). Migrations 0000-0018 applied.
  `db:verify --remote`: 89 triggers (expected 89), 8 views (expected 8).
- Worker `maktab` (env production), version `bf80587e-68e9-4c96-bf5d-943da17f1088`, cron `*/30 * * * *`.
- Secret `SESSION_SECRET` set (random, never displayed). Var `OWNER_EMAIL` = faysalfuturistic@gmail.com.
- R2 `maktab-files`: NOT created. API error 10042 "Please enable R2 through the Cloudflare Dashboard".
  Production `FILES` binding is commented out; photo upload returns 501 until enabled.

## Commands (from apps/api unless noted; CI=1 WRANGLER_SEND_METRICS=false)
    npx wrangler whoami
    npm ci --ignore-scripts && npm run build          # repo root
    npx wrangler d1 create maktab
    npx wrangler r2 bucket create maktab-files        # failed, see above
    npx wrangler d1 migrations apply DB --remote --env production
    npm run db:verify -- --remote --env production    # repo root
    openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env production
    npx wrangler deploy --env production

## Checks
/api/health 200 {"status":"ok"}; /api/me 401; /api/auth/google/start 500 misconfigured (expected);
/ serves CSP + nosniff + frame headers; /manifest.webmanifest is application/manifest+json.
Tail of 20 health requests: cpuTime 0-1 ms, wallTime 1-2 ms.

## Pending (user)
1. Enable R2 (dashboard, card on file), then `npx wrangler r2 bucket create maktab-files`, uncomment the
   `[[env.production.r2_buckets]]` block in apps/api/wrangler.toml, redeploy.
2. Google OAuth client: Google Cloud console -> APIs & Services -> OAuth consent screen (External,
   publish it; scopes openid/email/profile only) -> Credentials -> OAuth client ID (Web) ->
   Authorised JavaScript origin `https://maktab.conceptlix.com`, redirect URI
   `https://maktab.conceptlix.com/api/auth/google/callback`. Then from apps/api:
       npx wrangler secret put GOOGLE_CLIENT_ID --env production
       npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   (paste when prompted), then sign in at https://maktab.conceptlix.com with faysalfuturistic@gmail.com
   (first sign-in becomes owner).
3. Backups (GitHub repo): secrets CLOUDFLARE_API_TOKEN (D1 Edit + R2 Edit), CLOUDFLARE_ACCOUNT_ID
   (`c2cb545de480a9e59b9e0d75d555c56f`), AGE_RECIPIENT, B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT;
   repo variable BACKUP_ENABLED=true. The backup R2 bucket `maktab-backups` also needs R2 enabled.
