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
