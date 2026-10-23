import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Without arguments: checks that the Dockerfile's default label values match package.json (no Docker needed).
// With an image reference: also checks the labels of that built image. Pass the build args used as
// `APP_VERSION=… APP_REVISION=…` environment variables to expect them instead of the defaults.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const dockerfile = readFileSync('Dockerfile', 'utf8');
const argDefault = (name: string) => dockerfile.match(new RegExp(String.raw`^ARG ${name}=(\S+)\s*$`, 'm'))?.[1];
assert.equal(argDefault('APP_VERSION'), pkg.version, 'Dockerfile ARG APP_VERSION default must equal package.json version.');
assert.ok(argDefault('APP_REVISION'), 'Dockerfile must give ARG APP_REVISION a default so builds without build args still work.');

const expected = {
  'org.opencontainers.image.title': 'Ten98 Campaign',
  'org.opencontainers.image.description': pkg.description,
  'org.opencontainers.image.source': pkg.repository.url.replace(/\.git$/, ''),
  'org.opencontainers.image.licenses': pkg.license,
  'org.opencontainers.image.version': process.env.APP_VERSION ?? pkg.version,
  'org.opencontainers.image.revision': process.env.APP_REVISION ?? argDefault('APP_REVISION'),
};
const image = process.argv[2];
if (image) {
  const labels: Record<string, string> | null = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image], { encoding: 'utf8' }));
  for (const [key, value] of Object.entries(expected)) assert.equal(labels?.[key], value, `Image label ${key}`);
}
console.log(image ? 'Dockerfile defaults and image OCI labels passed.' : 'Dockerfile OCI label defaults match package.json.');
