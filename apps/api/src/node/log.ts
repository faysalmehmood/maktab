/**
 * One line for an unexpected error on the self-hosted server's log (docker logs, kept on disk): the
 * error's name, message and code only. A drizzle query error's message is
 * "Failed query: <sql>\nparams: <values>", so the parameters (names, phone numbers, amounts) are cut
 * off and the underlying driver error's message and code are used instead. No stack, no cause chain.
 */
export function safeErrorLine(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown } | null;
  const cause = (e?.cause ?? null) as { message?: unknown; code?: unknown } | null;
  let message = typeof e?.message === 'string' ? e.message : String(err);
  if (/^Failed query:/.test(message) && cause && typeof cause.message === 'string')
    message = `query failed: ${cause.message}`;
  // Whatever else: never past a "params:" marker, one line, bounded.
  message = message.split(/\bparams:/)[0] ?? '';
  message = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  const code =
    typeof e?.code === 'string' ? e.code : typeof cause?.code === 'string' ? cause.code : undefined;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return `${name}: ${message}${code ? ` (${code})` : ''}`;
}

export const logErrorLine = (err: unknown) =>
  console.error(`[maktab] internal error: ${safeErrorLine(err)}`);
