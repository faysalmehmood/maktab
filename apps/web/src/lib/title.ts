import { useEffect } from 'react';

/*
 * A page that owns the browser tab title for a while (the printed attendance register: Chrome prints
 * the title in its header line and offers it as the PDF's file name). While it is set, the shell's
 * own "short name · Maktab" title effect leaves the tab alone; on unmount the previous title comes
 * back.
 */
let override: string | null = null;

/** The title a page has claimed, or null; the shell checks it before writing its own. */
export const titleOverride = (): string | null => override;

export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    override = title;
    document.title = title;
    return () => {
      override = null;
      document.title = prev;
    };
  }, [title]);
}
