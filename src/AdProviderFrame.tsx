import React from 'react';
import { Card, Inline, Stack, Text } from '@ten98/ui';

// One advertising provider's panel. In Settings (connection) it sits inline under the integration's own heading; on the
// Ads workflow it is its own card.
export default function AdProviderFrame({ connection, title, description, actions, children }: { connection: boolean; title: string; description: string; actions: React.ReactNode; children: React.ReactNode }) {
  return connection ? <Stack gap={3}><Inline justify="between" align="center"><Text tone="muted">{description}</Text>{actions}</Inline>{children}</Stack> : <Card as="section" headingLevel={2} title={title} description={description} actions={actions}><Stack gap={4}>{children}</Stack></Card>;
}
