import { useEffect } from 'react';

/*
 * The browser tab title. The shell wants "short name · Maktab" (UI plan §6.4); a page may claim
 * the title for a while (the printed attendance register: Chrome prints the title in its header
 * line and offers it as the PDF's file name). The shell's latest wish is kept here even while a
 * page holds the title, so a language or school-name change meanwhile is not lost: when the page
 * lets go, the tab shows what the shell wants now, not what it wanted at mount.
 */
let override: string | null = null;
let shellTitle: string | null = null;

/** The shell's title; written to the tab unless a page has claimed it. */
export function setShellTitle(title: string): void {
  shellTitle = title;
  if (!override) document.title = title;
}

export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    override = title;
    document.title = title;
    return () => {
      override = null;
      document.title = shellTitle ?? prev;
    };
  }, [title]);
}
