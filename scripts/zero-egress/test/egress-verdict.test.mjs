import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const verdict = join(here, '..', 'egress-verdict.mjs');
const dir = mkdtempSync(join(tmpdir(), 'egress-verdict-'));

function run(lines, args = []) {
	const log = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(log, lines.map(l => JSON.stringify({ time: 't', ...l })).join('\n') + '\n');
	return spawnSync(process.execPath, [verdict, log, ...args], { encoding: 'utf8' });
}
function check(name, cond, r) {
	if (!cond) { console.error(`FAIL: ${name}`); console.error(r.status, r.stdout, r.stderr); process.exit(1); }
}

let r = run([{ host: '127.0.0.1', port: 11434 }, { host: '10.255.255.1', port: 8000 }], ['--allow', '10.255.255.1:8000']);
check('allowed passes', r.status === 0 && r.stdout.includes('EGRESS TEST PASSED'), r);

r = run([{ host: '127.0.0.1', port: 11434 }, { host: 'api.github.com', port: 443 }], ['--allow', '10.255.255.1:8000']);
check('external fails and is named', r.status === 1 && r.stdout.includes('api.github.com:443') && !r.stdout.includes('EGRESS TEST PASSED'), r);

r = run([{ host: '10.255.255.1', port: 8000 }]);
check('unallowed private fails', r.status === 1 && r.stdout.includes('10.255.255.1:8000'), r);

r = run([{ host: '10.255.255.1', port: 9999 }], ['--allow', '10.255.255.1:8000']);
check('allow is port-specific', r.status === 1, r);

r = run([{ host: 'localhost', port: 1 }, { host: 'a.localhost', port: 1 }, { host: '::1', port: 1 }, { host: '[::1]', port: 1 }, { host: '127.5.6.7', port: 1 }, { host: '::ffff:127.0.0.1', port: 1 }]);
check('loopback forms pass', r.status === 0, r);

r = run([{ host: 'localhost.evil.com', port: 443 }, { host: '128.0.0.1', port: 80 }]);
check('lookalikes fail', r.status === 1 && r.stdout.includes('localhost.evil.com:443') && r.stdout.includes('128.0.0.1:80'), r);

r = run([]);
check('empty log passes', r.status === 0, r);

console.log('PASS egress-verdict');
