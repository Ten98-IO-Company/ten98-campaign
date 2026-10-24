import { useState } from 'react';
import { Badge, Button, Card, Inline, List, ListItem, Progress, Stack, Text } from '@ten98/ui';

export type SetupStep = { id: string; title: string; detail: string; done: boolean; action: string; onAction: () => void };
type Props = { projectId: string; steps: SetupStep[] };

// Home's first-run checklist, composed from library primitives until the shared SetupChecklist
// (ten98-design-system#98) ships. Steps read real project state; hiding it is a per-browser convenience.
const hiddenKey = (projectId: string) => 'ten98-campaign-setup-hidden:' + projectId;
function readHidden(projectId: string) { try { return globalThis.localStorage?.getItem(hiddenKey(projectId)) === '1'; } catch { return false; } }

export default function HomeSetup({ projectId, steps }: Props) {
  const [hidden, setHidden] = useState(() => readHidden(projectId));
  const done = steps.filter(step => step.done).length, next = steps.find(step => !step.done);
  if (hidden || !next) return null;
  function hide() {
    setHidden(true);
    try { globalThis.localStorage?.setItem(hiddenKey(projectId), '1'); } catch { /* Stays hidden until the page reloads. */ }
  }
  return <Card as="section" headingLevel={2} title="Set up Campaign" description={`${done} of ${steps.length} done`} actions={<Button variant="ghost" size="sm" onClick={hide}>Hide</Button>}>
    <Stack gap={3}>
      <Progress value={done / steps.length * 100} label="Setup progress"/>
      <List gap={3}>{steps.map(step => <ListItem key={step.id}><Inline justify="between" align="center" gap={3}>
        <Stack gap={0}><Text weight="semibold">{step.title}</Text><Text tone="muted" size="sm">{step.detail}</Text></Stack>
        {step.done ? <Badge tone="success">Done</Badge> : <Button variant="secondary" size="sm" onClick={step.onAction}>{step.action}</Button>}
      </Inline></ListItem>)}</List>
    </Stack>
  </Card>;
}
