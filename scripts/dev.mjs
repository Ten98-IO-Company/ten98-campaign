import { spawn } from 'node:child_process';

process.env.PORT ||= '3018';
process.env.APP_URL = process.env.DEV_APP_URL || 'http://127.0.0.1:5178';
const children = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(child => child.kill());
  process.exitCode = code;
}
children.forEach(child => { child.on('error', () => stop(1)); child.on('exit', code => stop(code ?? 0)); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
