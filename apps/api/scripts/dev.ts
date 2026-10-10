/**
 * `npm run dev -w @maktab/api`: wrangler dev on API_PORT (default 8787), with APP_ORIGIN pointed
 * at the Vite dev server on PORT (default 5173), so both ports can move together when the defaults
 * are taken. A script rather than `${API_PORT:-8787}` in package.json so it also runs on Windows.
 */
import { spawn } from 'node:child_process';

const apiPort = process.env.API_PORT ?? '8787';
const webPort = process.env.PORT ?? '5173';
const args = [
  'dev',
  '--local',
  '--port',
  apiPort,
  '--var',
  `APP_ORIGIN:http://localhost:${webPort}`,
  ...process.argv.slice(2),
];
const child = spawn('wrangler', args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
