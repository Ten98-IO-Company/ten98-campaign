import test from 'node:test';
import { execFileSync } from 'node:child_process';

// The Dockerfile cannot read package.json for its label default, so this keeps the two in step on every release bump.
test('Dockerfile OCI label defaults match package.json', () => {
  execFileSync(process.execPath, ['scripts/check-image-labels.mjs'], { stdio: 'pipe' });
});
