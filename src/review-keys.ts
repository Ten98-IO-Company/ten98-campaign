// Ported from pendpost/pendpost@42ac77b29f7720a912bdce1507b16a2a56fca74f app/src/components/Freigaben.jsx:169-215 (MIT):
// card-level review keys. Arrow keys move between cards; A approves and R requests changes on the focused card.
export type ReviewKeyAction = 'approve' | 'reject' | 'next' | 'previous' | null;
type KeyInput = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; target: EventTarget | null; currentTarget: EventTarget | null };

export function reviewKeyAction(event: KeyInput, actionable: boolean, approveBlocked: boolean): ReviewKeyAction {
  // Keys pressed inside a card's own controls (note field, buttons) belong to those controls.
  if (event.target !== event.currentTarget) return null;
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  if (!actionable || event.altKey || event.ctrlKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  // Approval stays blocked at the keyboard exactly as at the button; requesting changes is always the way out.
  if (key === 'a') return approveBlocked ? null : 'approve';
  return key === 'r' ? 'reject' : null;
}
