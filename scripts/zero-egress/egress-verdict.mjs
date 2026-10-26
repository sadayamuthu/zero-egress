#!/usr/bin/env node
// Usage: egress-verdict.mjs <log.jsonl> [--allow host:port]...
// Exit 0 + "EGRESS TEST PASSED" if every logged attempt is loopback or allowed.
import { readFileSync } from 'node:fs';

function normalizeHost(h) {
	h = String(h).toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) { h = h.slice(1, -1); }
	if (h.endsWith('.')) { h = h.slice(0, -1); }
	return h;
}
function parseIPv4(h) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) { return undefined; }
	const p = m.slice(1).map(Number);
	return p.every(n => n <= 255) ? p : undefined;
}
function mappedIPv4(h) {
	const m = /^::ffff:(.+)$/.exec(h);
	return m ? parseIPv4(m[1]) : undefined;
}
// Mirrors isLoopbackHost in src/vs/workbench/contrib/zeroEgress/common/egressPolicy.ts
export function isLoopbackHost(host) {
	const h = normalizeHost(host);
	if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') { return true; }
	const v4 = parseIPv4(h) ?? mappedIPv4(h);
	return !!v4 && (v4[0] === 127 || v4.every(n => n === 0));
}

const args = process.argv.slice(2);
const allow = new Set();
let logPath;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--allow') {
		const v = args[++i] ?? '';
		const m = /^(.*):(\d+)$/.exec(v);
		if (!m) { console.error(`bad --allow value: ${v}`); process.exit(2); }
		allow.add(`${normalizeHost(m[1])}:${m[2]}`);
	}
	else { logPath = args[i]; }
}
if (!logPath) { console.error('usage: egress-verdict.mjs <log> [--allow host:port]...'); process.exit(2); }

const offenders = new Set();
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
	if (!line.trim()) { continue; }
	let e;
	try { e = JSON.parse(line); } catch { offenders.add(`unparseable log line: ${line.slice(0, 80)}`); continue; }
	if (isLoopbackHost(e.host) || allow.has(`${normalizeHost(e.host)}:${e.port}`)) { continue; }
	offenders.add(`${e.host}:${e.port}`);
}
if (offenders.size) {
	console.log('EGRESS TEST FAILED. Disallowed destinations:');
	for (const o of offenders) { console.log(`  ${o}`); }
	process.exit(1);
}
console.log('EGRESS TEST PASSED');
