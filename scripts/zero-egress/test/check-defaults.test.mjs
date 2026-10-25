import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, '..', 'check-defaults.mjs');
const root = join(here, '..', '..', '..');
const r = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
if (r.status !== 0 || !r.stdout.includes('DEFAULTS OK')) {
	console.error('FAIL: expected exit 0 and DEFAULTS OK');
	console.error(r.stdout, r.stderr);
	process.exit(1);
}
console.log('PASS check-defaults');
