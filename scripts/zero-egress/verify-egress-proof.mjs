#!/usr/bin/env node
// Standalone offline verifier for a ZeroEgress Egress Proof report.
// Usage: node verify-egress-proof.mjs <report.json> [report.pdf]
// Uses node:crypto and node:fs only. A port of the checks in egressProof.ts / egressProofReport.ts / egressProofKey.ts:
// keep the two in step (the fixtures test compares them check by check).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCOPE = 'Covers connections made by ZeroEgress itself. Programs it starts (git, terminal and agent commands, language servers) are not covered.';
const SIGNATURE_LIMIT = 'A valid signature proves this report wasn\'t changed and was made with this device\'s key. It does not prove the machine itself wasn\'t tampered with.';
const GENESIS_HASH = '0'.repeat(64);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Ordinal comparison, never localeCompare.
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function stableStringify(value) {
	if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
	if (Array.isArray(value)) { return '[' + value.map(stableStringify).join(',') + ']'; }
	const keys = Object.keys(value).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function chainHash(prevHash, body) {
	return createHash('sha256').update(prevHash).update(stableStringify(body)).digest('hex');
}

function canonicalProof(body) {
	const { signature: _signature, ...rest } = body;
	return stableStringify(rest);
}

function timeOf(body) {
	switch (body.type) {
		case 'heartbeat': return body.hour;
		case 'allowed': return body.hour;
		case 'blocked': return body.minute;
		case 'blocked_lookup': return body.minute;
		default: return body.time;
	}
}

function sortedUnique(values) { return [...new Set(values)].sort(cmp); }

function accumulate(map, key, time, origin, count, kind, reason) {
	let a = map.get(key);
	if (!a) {
		a = { kind, reasons: new Set(), origins: new Set(), count: 0, first: time, last: time };
		map.set(key, a);
	}
	if (reason !== undefined) { a.reasons.add(reason); }
	a.origins.add(origin);
	a.count += count;
	if (time < a.first) { a.first = time; }
	if (time > a.last) { a.last = time; }
}

function computeRows(records) {
	const allowed = new Map();
	const blocked = new Map();
	const lookups = new Map();
	for (const { body } of records) {
		if (body.type === 'allowed') { accumulate(allowed, body.dest, body.hour, body.origin, body.count, body.kind, body.reason); }
		else if (body.type === 'blocked') { accumulate(blocked, body.dest, body.minute, body.origin, body.count); }
		else if (body.type === 'blocked_lookup') { accumulate(lookups, body.host, body.minute, body.origin, body.count); }
	}
	const keys = m => [...m.keys()].sort(cmp);
	return {
		allowed: keys(allowed).map(dest => {
			const a = allowed.get(dest);
			return { dest, kind: a.kind, reasons: sortedUnique(a.reasons), origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
		blocked: keys(blocked).map(dest => {
			const a = blocked.get(dest);
			return { dest, origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
		lookupsBlocked: keys(lookups).map(host => {
			const a = lookups.get(host);
			return { host, origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
	};
}

function computeSessions(records, period) {
	const hours = new Set();
	const crashGaps = [];
	let openStart = records.length > 0 && records[0].body.type !== 'session_start' ? timeOf(records[0].body) : undefined;
	let lastHeartbeat;
	for (const { body } of records) {
		if (body.type === 'heartbeat') {
			if (body.hour >= period.from && body.hour < period.to) { hours.add(body.hour); }
			if (openStart !== undefined) { lastHeartbeat = body.hour; }
		} else if (body.type === 'session_start') {
			if (openStart !== undefined) {
				crashGaps.push({ from: lastHeartbeat ?? openStart, to: body.time, why: 'crash' });
			}
			openStart = body.time;
			lastHeartbeat = undefined;
		} else if (body.type === 'session_end') {
			openStart = undefined;
			lastHeartbeat = undefined;
		}
	}
	return { hoursRecorded: hours.size, crashGaps };
}

const sortGaps = gaps => gaps.sort((a, b) => cmp(a.from, b.from) || cmp(a.why, b.why) || cmp(a.to ?? '', b.to ?? ''));

function checkChain(ledger) {
	const name = 'Records form an unbroken chain';
	const { records } = ledger;
	let hash = ledger.prevHashBeforeFirst;
	if (records.length === 0 && (ledger.firstSeq !== 0 || ledger.headSeq !== 0)) {
		return { name, ok: false, detail: 'No records, but a first or head seq is stated' };
	}
	if (records.length > 0 && records[0].seq !== ledger.firstSeq) {
		return { name, ok: false, detail: `First record is seq ${records[0].seq}, expected ${ledger.firstSeq}` };
	}
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		if (i > 0 && r.seq !== records[i - 1].seq + 1) { return { name, ok: false, detail: `Record after seq ${records[i - 1].seq} is seq ${r.seq}` }; }
		if (r.prevHash !== hash) { return { name, ok: false, detail: `Record ${r.seq} does not follow the one before it` }; }
		hash = chainHash(r.prevHash, { seq: r.seq, body: JSON.parse(JSON.stringify(r.body)) });
	}
	if (records.length > 0 && records[records.length - 1].seq !== ledger.headSeq) {
		return { name, ok: false, detail: `Last record is seq ${records[records.length - 1].seq}, expected ${ledger.headSeq}` };
	}
	if (hash !== ledger.headHash) { return { name, ok: false, detail: 'Chain ends at a different hash than the stated head' }; }
	return { name, ok: true };
}

function firstMismatch(stated, computed, keyOf) {
	const byKey = rows => new Map(rows.map(r => [keyOf(r), stableStringify(r)]));
	const s = byKey(stated);
	const c = byKey(computed);
	for (const [k, v] of s) { if (c.get(k) !== v) { return k; } }
	for (const k of c.keys()) { if (!s.has(k)) { return k; } }
	return stated.length !== computed.length ? 'duplicate rows' : undefined;
}

function checkRows(body) {
	const name = 'Every row recomputes from the records';
	const rows = computeRows(body.ledger.records);
	const same = stableStringify(body.allowed) === stableStringify(rows.allowed) &&
		stableStringify(body.blocked) === stableStringify(rows.blocked) &&
		stableStringify(body.lookupsBlocked) === stableStringify(rows.lookupsBlocked);
	if (same) { return { name, ok: true }; }
	const bad =
		firstMismatch(body.allowed, rows.allowed, r => r.dest) ??
		firstMismatch(body.blocked, rows.blocked, r => r.dest) ??
		firstMismatch(body.lookupsBlocked, rows.lookupsBlocked, r => r.host);
	return { name, ok: false, detail: bad !== undefined ? `Row for ${bad} does not match the records` : 'Rows are not in the expected order' };
}

const isIso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && !isNaN(Date.parse(v));

function checkCoverage(body) {
	const name = 'Coverage recomputes from the records';
	const { coverage } = body;
	const { hoursRecorded, crashGaps } = computeSessions(body.ledger.records, body.period);
	if (coverage.hoursRecorded !== hoursRecorded) {
		return { name, ok: false, detail: `Hours recorded is ${coverage.hoursRecorded}, the records give ${hoursRecorded}` };
	}
	const stated = coverage.gaps.filter(g => g.why === 'crash');
	if (stableStringify(stated) !== stableStringify(sortGaps(crashGaps))) {
		return { name, ok: false, detail: 'Crash gaps do not match the records' };
	}
	for (const g of coverage.gaps) {
		if ((g.why !== 'crash' && g.why !== 'reset' && g.why !== 'chain') || !isIso(g.from) || (g.to !== undefined && !isIso(g.to))) {
			return { name, ok: false, detail: 'A gap is malformed' };
		}
	}
	if (body.verdict !== (coverage.gaps.length > 0 ? 'gaps' : 'ok')) {
		return { name, ok: false, detail: 'Verdict does not match the gaps' };
	}
	return { name, ok: true };
}

function checkProofBody(body) {
	return [
		checkChain(body.ledger),
		checkRows(body),
		checkCoverage(body),
		body.scope === SCOPE ? { name: 'Scope statement present', ok: true } : { name: 'Scope statement present', ok: false, detail: 'Scope statement is missing or changed' },
	];
}

function verifySignature(publicKey, data, signature) {
	try {
		const raw = Buffer.from(publicKey, 'base64');
		if (raw.length !== 32) { return false; }
		const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
		return verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signature, 'base64'));
	} catch {
		return false;
	}
}

function malformed(v) {
	const isObj = x => typeof x === 'object' && x !== null && !Array.isArray(x);
	if (!isObj(v)) { return 'The file is not a JSON object'; }
	if (v.schemaVersion !== 1) { return `Unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}; expected 1`; }
	const need = [
		['period', isObj(v.period)],
		['identity', isObj(v.identity)],
		['coverage', isObj(v.coverage) && Array.isArray(v.coverage.gaps)],
		['allowed', Array.isArray(v.allowed)],
		['blocked', Array.isArray(v.blocked)],
		['lookupsBlocked', Array.isArray(v.lookupsBlocked)],
		['ledger', isObj(v.ledger) && Array.isArray(v.ledger.records)],
		['key', isObj(v.key) && typeof v.key.publicKey === 'string'],
	];
	const bad = need.find(([, ok]) => !ok);
	return bad ? `Missing or malformed field: ${bad[0]}` : undefined;
}

/** All checks in order: signature, the four body checks, the PDF if given. Returns { checks, body }. */
export function verifyReportText(jsonText, pdf) {
	let parsed;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return { checks: [{ name: 'Report file is readable', ok: false, detail: 'The file is not valid JSON' }] };
	}
	const why = malformed(parsed);
	if (why) { return { checks: [{ name: 'Report file is readable', ok: false, detail: why }] }; }
	const body = parsed;

	const checks = [];
	const signature = body.signature;
	checks.push(typeof signature !== 'string'
		? { name: 'Signature valid', ok: false, detail: 'The report has no signature' }
		: verifySignature(body.key.publicKey, canonicalProof(body), signature)
			? { name: 'Signature valid', ok: true }
			: { name: 'Signature valid', ok: false, detail: 'The signature does not match this report and key' });

	try {
		checks.push(...checkProofBody(body));
	} catch (e) {
		checks.push({ name: 'Records form an unbroken chain', ok: false, detail: `The report could not be checked: ${e instanceof Error ? e.message : String(e)}` });
	}

	if (pdf) {
		const sha = createHash('sha256').update(pdf).digest('hex');
		checks.push(sha === body.pdfSha256
			? { name: 'PDF matches JSON', ok: true }
			: { name: 'PDF matches JSON', ok: false, detail: 'The PDF is not the one this report was made with' });
	}
	return { checks, body };
}

function fingerprintOf(publicKeyB64) {
	const raw = Buffer.from(publicKeyB64, 'base64');
	return createHash('sha256').update(raw).digest('hex').slice(0, 16).match(/.{4}/g).join('-');
}

function readBounded(file) {
	const st = statSync(file);
	if (!st.isFile()) { throw new Error('Not a regular file'); }
	if (st.size > MAX_FILE_BYTES) { throw new Error(`The file is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB`); }
	return readFileSync(file);
}

function main(argv) {
	if (argv.length < 1 || argv.length > 2) {
		console.error('Usage: node verify-egress-proof.mjs <report.json> [report.pdf]');
		return 2;
	}
	let checks;
	let body;
	try {
		const json = readBounded(argv[0]).toString('utf8');
		const pdf = argv[1] !== undefined ? readBounded(argv[1]) : undefined;
		({ checks, body } = verifyReportText(json, pdf));
	} catch (e) {
		checks = [{ name: 'Report file is readable', ok: false, detail: e instanceof Error ? e.message : String(e) }];
	}
	for (const c of checks) {
		console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok || !c.detail ? '' : ` - ${c.detail}`}`);
	}
	if (body) {
		let fp = '';
		try { fp = fingerprintOf(body.key.publicKey); } catch { /* shown blank */ }
		console.log(`\nKey fingerprint: ${fp}`);
	}
	console.log(SIGNATURE_LIMIT);
	return checks.every(c => c.ok) ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { process.exitCode = main(process.argv.slice(2)); }
