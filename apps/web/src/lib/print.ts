/**
 * Every print button goes through here: wait for the web fonts (Noto Nastaliq Urdu is fetched only
 * when Urdu text first renders), or the first page prints in a fallback font with wrong line
 * heights — and a thermal page measured for the wrong height. `document.fonts` is missing in some
 * WebViews and in jsdom, so it is guarded. A font that never settles does not block printing.
 */
export async function printWhenReady(timeoutMs = 3000): Promise<void> {
  const ready = typeof document !== 'undefined' ? document.fonts?.ready : undefined;
  if (ready)
    await Promise.race([ready, new Promise<void>((r) => setTimeout(r, timeoutMs))]).catch(
      () => undefined,
    );
  window.print();
}
