import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'check-minified-ascii.mjs');

/** Writes `files` ({ relative path: source }) to a fresh folder and runs the check on it. */
function run(files) {
	const dir = mkdtempSync(join(tmpdir(), 'minified-ascii-'));
	for (const [p, src] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), src);
	}
	return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
}
function check(name, cond, r) {
	if (!cond) { console.error(`FAIL: ${name}`); console.error(r.status, r.stdout, r.stderr); process.exit(1); }
}

let r = run({ 'a.js': 'export const f = s => s.replace(/[\\r\\n\\u201D]/g, " ");\n' });
check('escaped regex passes', r.status === 0 && r.stdout.includes('MINIFIED ASCII CHECK PASSED (1 files)'), r);

r = run({ 'a.js': 'export const label = "Always allow “" + 1 + "”";\n' });
check('non-ASCII in a string passes (esbuild escapes it)', r.status === 0, r);

r = run({ 'a.js': 'export const s = "café";\n' });
check('Latin-1 passes, as in the release check', r.status === 0, r);

r = run({ 'sub/bad.js': 'export const f = s => s.replace(/[”]/g, " ");\n' });
check('raw non-ASCII in a regex fails and names the file', r.status === 1 && r.stderr.includes('bad.js') && r.stderr.includes('”'), r);

r = run({ 'test/bad.js': 'export const f = s => s.replace(/[”]/g, " ");\n', 'ok.js': 'export const x = 1;\n' });
check('test folders are skipped', r.status === 0 && r.stdout.includes('(1 files)'), r);

r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
check('no folder is a usage error', r.status === 2, r);

console.log('check-minified-ascii tests passed');
