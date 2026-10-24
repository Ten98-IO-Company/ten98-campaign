import { useEffect } from 'react';

// A row action that opens a panel elsewhere on the page (an edit form, a confirmation) should bring it to the person:
// each time `trigger` changes, the element with `id` scrolls into view and its first enabled field takes focus.
export function useRevealPanel(trigger: number, id: string) {
  useEffect(() => {
    if (!trigger || !id) return;
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.scrollIntoView({ block: 'start' });
    panel.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true });
  }, [trigger, id]);
}
