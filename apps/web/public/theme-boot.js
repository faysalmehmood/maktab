/*
 * Theme before first paint (M7b). Runs synchronously in <head>, before the app bundle: the saved
 * choice (`maktab.theme`, set in the account menu) or the phone's setting picks light/dark, and the
 * last school colour seen (`maktab.brand`) is applied, so a reload never flashes white or teal.
 * A file, not an inline <script>: the CSP allows scripts from 'self' only. lib/theme.ts takes over
 * once the app starts (same keys, same classes).
 */
(() => {
  const root = document.documentElement;
  try {
    const pref = localStorage.getItem('maktab.theme');
    const dark =
      pref === 'dark' ||
      (pref !== 'light' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.add(dark ? 'dark' : 'light');
    const brand = localStorage.getItem('maktab.brand');
    if (brand && /^(blue|maroon|purple|green)$/.test(brand)) root.setAttribute('data-brand', brand);
  } catch {
    // Storage blocked (private mode): the inline <style> in index.html still follows the phone.
  }
})();
