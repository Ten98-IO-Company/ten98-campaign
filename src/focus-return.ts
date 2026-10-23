import { useEffect, useRef } from 'react';

// A @ten98/ui Button is disabled while its action is busy, and a disabled button loses focus to <body>.
// Call the returned function when a busy action starts: once `busy` clears, focus goes back to the control
// that was focused, unless that control is gone or the person has moved focus somewhere else meanwhile.
export function useFocusReturn(busy: unknown) {
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = target.current;
    if (busy || !element) return;
    target.current = null;
    const active = document.activeElement;
    if (element.isConnected && (!active || active === document.body)) element.focus();
  }, [busy]);
  return () => {
    const active = document.activeElement;
    target.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
}

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
