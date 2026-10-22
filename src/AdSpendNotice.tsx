import { Alert, Button } from '@ten98/ui';
import type { AdSpendBlock } from './approval-status';

// Explains a spend change the ad spend approval policy held back, beside the control that attempted it.
export default function AdSpendNotice({ block, onOpenApprovals, onDismiss }: { block: AdSpendBlock; onOpenApprovals?: () => void; onDismiss?: () => void }) {
  return <Alert tone={block.review ? 'info' : 'warning'} title={block.title} onDismiss={onDismiss} dismissLabel="Dismiss" actions={block.review && onOpenApprovals ? <Button variant="secondary" size="sm" onClick={onOpenApprovals}>Open approvals</Button> : undefined}>{block.text}</Alert>;
}
