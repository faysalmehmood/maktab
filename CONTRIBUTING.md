# Contributing

Thanks for helping. Maktab is small on purpose; please keep it that way.

- Read [docs/PLAN.md](docs/PLAN.md) first. Larger changes start as an issue or an ADR in `docs/ADR/`.
- Before a pull request: `npm run typecheck && npm run lint && npm test && npm run build`.
- Every new API route goes through `defineRoute(... requires(resource, action) ...)` and gets a row in
  the snapshot in `apps/api/test/permissions.test.ts`. Undeclared routes are refused at runtime.
- Money is integer paisa, money rows are never updated or deleted, and balances are derived.
- Schema changes: edit `packages/db/src/schema`, run `npm run db:generate`, commit the migration.
  Triggers, views and partial indexes live in `packages/db/sql/`.
- Every user-facing string needs both `en` and `ur` (`packages/shared/src/i18n.ts`; the type
  checker enforces matching keys). Numbers stay in Latin digits.
- Comments explain why, not what. No `any`.

By contributing you agree your work is licensed under AGPL-3.0. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).
