#!/usr/bin/env node
// Usage: egress-verdict.mjs <log.jsonl> --expect host:port [--expect host:port]... [--allow host:port]...
// Exit 0 + "EGRESS TEST PASSED" if every logged attempt is loopback or allowed, AND every --expect
// destination was logged at least once. --expect is the positive control: an attempt the session makes
// on purpose to a destination it is allowed to reach (for example a loopback fetch through the proxy), so a
// log that shows nothing proves the observer saw the app's traffic rather than that it saw nothing at all.
// A missing or empty log, or a run without --expect, fails. An --expect destination is also allowed.
import { existsSync, readFileSync } from 'node:fs';

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
const expect = new Set();
let logPath;
const usage = 'usage: egress-verdict.mjs <log> --expect host:port... [--allow host:port]...';
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--allow' || args[i] === '--expect') {
		const v = args[i + 1] ?? '';
		const m = /^(.*):(\d+)$/.exec(v);
		if (!m) { console.error(`bad ${args[i]} value: ${v}`); process.exit(2); }
		const key = `${normalizeHost(m[1])}:${m[2]}`;
		allow.add(key);
		if (args[i] === '--expect') { expect.add(key); }
		i++;
	}
	else { logPath = args[i]; }
}
if (!logPath) { console.error(usage); process.exit(2); }

const problems = [];
if (!expect.size) {
	problems.push('no --expect positive control given: an empty log cannot tell a clean run from an observer that saw nothing');
}
if (!existsSync(logPath)) {
	problems.push(`log ${logPath} does not exist (did the proxy start?)`);
}
const offenders = new Set();
const seen = new Set();
let entries = 0;
for (const line of existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : []) {
	if (!line.trim()) { continue; }
	let e;
	try { e = JSON.parse(line); } catch { offenders.add(`unparseable log line: ${line.slice(0, 80)}`); continue; }
	entries++;
	const key = `${normalizeHost(e.host)}:${e.port}`;
	seen.add(key);
	if (isLoopbackHost(e.host) || allow.has(key)) { continue; }
	offenders.add(`${e.host}:${e.port}`);
}
if (existsSync(logPath) && !entries) {
	problems.push('the log is empty: the observer saw no traffic at all, not even the positive control');
}
for (const key of expect) {
	if (!seen.has(key)) { problems.push(`positive control ${key} never appeared in the log`); }
}
if (offenders.size || problems.length) {
	console.log('EGRESS TEST FAILED.');
	if (offenders.size) {
		console.log('Disallowed destinations:');
		for (const o of offenders) { console.log(`  ${o}`); }
	}
	for (const p of problems) { console.log(`  ${p}`); }
	process.exit(1);
}
console.log(`EGRESS TEST PASSED (${entries} logged attempts, positive control seen: ${[...expect].join(', ')})`);
