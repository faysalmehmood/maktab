import type { ApiErrorBody } from '@maktab/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string): ApiErrorBody => ({
  error: { code, message },
});

export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
  if (err instanceof HTTPException) {
    return c.json(errorBody('http_error', err.message || 'Request rejected'), err.status);
  }
  // Details go to the Workers log only; clients never see internals.
  console.error(err);
  return c.json(errorBody('internal', 'Internal error'), 500);
}

export const notFound = (c: Context): Response =>
  c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}`), 404);
