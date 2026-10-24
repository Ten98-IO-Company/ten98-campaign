import { AuthStory } from '@ten98/ui';

// The story panel beside every signed-out and onboarding screen (sign-in, owner setup, invitations and onboarding), as
// Discover passes its own: the shared AuthLayout then renders its split layout with the open form column.
export const authStory = <AuthStory label="Campaign overview" eyebrow="Campaign management" title="Plan. Publish." emphasis="Measure." lead="Manage social posts, advertising and campaign assets." channels={[{ icon: 'send', label: 'Social' }, { icon: 'target', label: 'Advertising' }, { icon: 'billboard', label: 'Out of home' }]} footnote="ten98 Campaign"/>;
