export function seedSample(store, projectId) {
  const add = (collection, data) => store.create(projectId, collection, { ...data, sample: true });
  const provider = add('providers', { name: 'Cityscape Media', type: 'ooh', contact: 'hello@example.com', location: 'Dubai, UAE', inventory: 24 });
  const campaign = add('campaigns', { name: 'A new perspective', channel: 'mixed', status: 'active', budget: 24000, spent: 12480, startDate: '2026-10-01', endDate: '2026-10-31', impressions: 384200, clicks: 6840, conversions: 218, color: '#5943ce' });
  add('campaigns', { name: 'The everyday collection', channel: 'social', status: 'draft', budget: 8500, spent: 0, startDate: '2026-11-01', endDate: '2026-11-30', impressions: 0, clicks: 0, conversions: 0, color: '#e39254' });
  add('campaigns', { name: 'City after hours', channel: 'ooh', status: 'paused', budget: 18000, spent: 5600, startDate: '2026-10-10', endDate: '2026-11-10', impressions: 96000, clicks: 0, conversions: 0, color: '#437868' });
  const asset = add('assets', { name: 'Autumn campaign — hero', kind: 'image', url: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1000&auto=format&fit=crop', size: '2.4 MB', approval: 'approved', tags: ['Autumn', 'Approved'] });
  add('assets', { name: 'City light — outdoor', kind: 'image', url: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=1000&auto=format&fit=crop', size: '4.1 MB', tags: ['Outdoor'] });
  add('assets', { name: 'Brand guidelines', kind: 'document', url: 'https://drive.google.com/', size: '1.2 MB', tags: ['Brand'] });
  add('posts', { content: 'A fresh perspective on the everyday. Discover the new collection, made for wherever life takes you. #ANewPerspective', platforms: ['instagram', 'facebook'], status: 'draft', campaignId: campaign.id, assetId: asset.id });
  add('posts', { content: 'A little inspiration for your next chapter. Something new is coming.', platforms: ['linkedin'], status: 'scheduled', scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(), campaignId: campaign.id });
  add('posts', { content: 'Meet your new everyday favorites. Explore the details that make a difference.', platforms: ['instagram'], status: 'published', publishedAt: '2026-10-15T09:00:00.000Z', campaignId: campaign.id, assetId: asset.id, impressions: 18400, engagement: 842 });
  add('placements', { name: 'Sheikh Zayed Road — North', providerId: provider.id, type: 'digital', location: 'Dubai, UAE', cost: 6500, status: 'live', startDate: '2026-10-01', endDate: '2026-10-31', impressions: 125000 });
  add('placements', { name: 'Downtown boulevard', providerId: provider.id, type: 'billboard', location: 'Downtown Dubai', cost: 4500, status: 'booked', startDate: '2026-11-01', endDate: '2026-11-30', impressions: 0 });
  store.activity(projectId, 'Sample campaign workspace created. These figures are illustrative.', true);
}
