/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure builder and checker for the Egress Proof report. No fs, no electron: the same row logic is ported
// to the standalone verifier script, so every sort here is ordinal (never localeCompare).

import { GENESIS_HASH, chainHash, stableStringify } from './auditTypes.js';
import { DestinationKind, EgressOrigin, LedgerBody, LedgerRecord } from './egressLedger.js';

export const EGRESS_PROOF_SCOPE = 'Covers connections made by ZeroEgress itself. Programs it starts (git, terminal and agent commands, language servers) are not covered.';
export const EGRESS_PROOF_SIGNATURE_LIMIT = 'A valid signature proves this report wasn\'t changed and was made with this device\'s key. It does not prove the machine itself wasn\'t tampered with.';

export interface EgressProofAllowedRow { dest: string; kind: DestinationKind; reasons: string[]; origins: EgressOrigin[]; count: number; first: string; last: string }
export interface EgressProofBlockedRow { dest: string; origins: EgressOrigin[]; count: number; first: string; last: string }
export interface EgressProofLookupRow { host: string; origins: EgressOrigin[]; count: number; first: string; last: string }
export interface EgressProofGap { from: string; to?: string; why: 'crash' | 'reset' | 'chain' }

export interface EgressProofBody {
	schemaVersion: 1;
	createdAt: string;
	period: { from: string; to: string };
	identity: { machineId: string; user: string; version: string; commit: string; os: string; networkSettings: string[] };
	scope: string;
	verdict: 'ok' | 'gaps';
	coverage: { hoursRecorded: number; gaps: EgressProofGap[] };
	allowed: EgressProofAllowedRow[];
	blocked: EgressProofBlockedRow[];
	lookupsBlocked: EgressProofLookupRow[];
	modelUsage: { auditCoverage: { from: string; to: string }[]; byModel: { provider: string; model: string; requests: number }[] } | null;
	policy: null;
	ledger: { firstSeq: number; headSeq: number; headHash: string; prevHashBeforeFirst: string; records: LedgerRecord[] };
	pdfSha256?: string;
	key: { publicKey: string; fingerprint: string; storage: 'safeStorage' | 'file' };
}

export interface EgressProofInput {
	createdAt: string;
	period: { from: string; to: string };
	identity: EgressProofBody['identity'];
	modelUsage: EgressProofBody['modelUsage'];
	resetSince?: string;
	brokenAtSeq?: number;
	key: EgressProofBody['key'];
}

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
	return [...new Set(values)].sort(cmp);
}

function timeOf(body: LedgerBody): string {
	switch (body.type) {
		case 'heartbeat': return body.hour;
		case 'allowed': return body.hour;
		case 'blocked': return body.minute;
		case 'blocked_lookup': return body.minute;
		default: return body.time;
	}
}

interface Acc { kind?: DestinationKind; reasons: Set<string>; origins: Set<EgressOrigin>; count: number; first: string; last: string }

function accumulate(map: Map<string, Acc>, key: string, time: string, origin: EgressOrigin, count: number, kind?: DestinationKind, reason?: string): void {
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

/** The three row sections, from every record given. Used both to build and to re-check a report. */
function computeRows(records: LedgerRecord[]): Pick<EgressProofBody, 'allowed' | 'blocked' | 'lookupsBlocked'> {
	const allowed = new Map<string, Acc>();
	const blocked = new Map<string, Acc>();
	const lookups = new Map<string, Acc>();
	for (const { body } of records) {
		if (body.type === 'allowed') { accumulate(allowed, body.dest, body.hour, body.origin, body.count, body.kind, body.reason); }
		else if (body.type === 'blocked') { accumulate(blocked, body.dest, body.minute, body.origin, body.count); }
		else if (body.type === 'blocked_lookup') { accumulate(lookups, body.host, body.minute, body.origin, body.count); }
	}
	const keys = (m: Map<string, Acc>) => [...m.keys()].sort(cmp);
	return {
		allowed: keys(allowed).map(dest => {
			const a = allowed.get(dest)!;
			return { dest, kind: a.kind!, reasons: sortedUnique(a.reasons), origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
		blocked: keys(blocked).map(dest => {
			const a = blocked.get(dest)!;
			return { dest, origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
		lookupsBlocked: keys(lookups).map(host => {
			const a = lookups.get(host)!;
			return { host, origins: sortedUnique(a.origins), count: a.count, first: a.first, last: a.last };
		}),
	};
}

function computeCoverage(records: LedgerRecord[], input: EgressProofInput): EgressProofBody['coverage'] {
	const { period, resetSince, brokenAtSeq } = input;
	const hours = new Set<string>();
	const gaps: EgressProofGap[] = [];
	let openStart: string | undefined; // session_start time of a session with no session_end yet
	let lastHeartbeat: string | undefined; // latest heartbeat in the open session
	for (const { body } of records) {
		if (body.type === 'heartbeat') {
			if (body.hour >= period.from && body.hour < period.to) { hours.add(body.hour); }
			if (openStart !== undefined) { lastHeartbeat = body.hour; }
		} else if (body.type === 'session_start') {
			if (openStart !== undefined) {
				gaps.push({ from: lastHeartbeat ?? openStart, to: body.time, why: 'crash' });
			}
			openStart = body.time;
			lastHeartbeat = undefined;
		} else if (body.type === 'session_end') {
			openStart = undefined;
			lastHeartbeat = undefined;
		}
	}
	if (resetSince !== undefined && resetSince > period.from) {
		gaps.push({ from: period.from, to: resetSince < period.to ? resetSince : period.to, why: 'reset' });
	}
	if (brokenAtSeq !== undefined) {
		const rec = records.find(r => r.seq === brokenAtSeq);
		gaps.push({ from: rec ? timeOf(rec.body) : period.from, why: 'chain' });
	}
	gaps.sort((a, b) => cmp(a.from, b.from) || cmp(a.why, b.why) || cmp(a.to ?? '', b.to ?? ''));
	return { hoursRecorded: hours.size, gaps };
}

export function buildEgressProof(records: LedgerRecord[], input: EgressProofInput): EgressProofBody {
	const coverage = computeCoverage(records, input);
	const first = records[0];
	const last = records[records.length - 1];
	return {
		schemaVersion: 1,
		createdAt: input.createdAt,
		period: { from: input.period.from, to: input.period.to },
		identity: input.identity,
		scope: EGRESS_PROOF_SCOPE,
		verdict: coverage.gaps.length > 0 ? 'gaps' : 'ok',
		coverage,
		...computeRows(records),
		modelUsage: input.modelUsage,
		policy: null,
		ledger: {
			firstSeq: first ? first.seq : 0,
			headSeq: last ? last.seq : 0,
			headHash: last ? chainHash(last.prevHash, { seq: last.seq, body: JSON.parse(JSON.stringify(last.body)) }) : GENESIS_HASH,
			prevHashBeforeFirst: first ? first.prevHash : GENESIS_HASH,
			records,
		},
		key: input.key,
	};
}

/** Everything except a `signature` field, key order irrelevant. This is the exact text that gets signed. */
export function canonicalProof(body: EgressProofBody): string {
	const { signature: _signature, ...rest } = body as EgressProofBody & { signature?: unknown };
	return stableStringify(rest);
}

export type ProofCheck = { name: string; ok: boolean; detail?: string };

function checkChain(ledger: EgressProofBody['ledger']): ProofCheck {
	const name = 'Records form an unbroken chain';
	const { records } = ledger;
	let hash = ledger.prevHashBeforeFirst;
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
	if (hash !== ledger.headHash) { return { name, ok: false, detail: `Chain ends at a different hash than the stated head` }; }
	return { name, ok: true };
}

function firstMismatch<T>(stated: T[], computed: T[], keyOf: (r: T) => string): string | undefined {
	const byKey = (rows: T[]) => new Map(rows.map(r => [keyOf(r), stableStringify(r)]));
	const s = byKey(stated);
	const c = byKey(computed);
	for (const [k, v] of s) { if (c.get(k) !== v) { return k; } }
	for (const k of c.keys()) { if (!s.has(k)) { return k; } }
	return stated.length !== computed.length ? 'duplicate rows' : undefined;
}

function checkRows(body: EgressProofBody): ProofCheck {
	const name = 'Every row recomputes from the records';
	const rows = computeRows(body.ledger.records);
	const bad =
		firstMismatch(body.allowed, rows.allowed, r => r.dest) ??
		firstMismatch(body.blocked, rows.blocked, r => r.dest) ??
		firstMismatch(body.lookupsBlocked, rows.lookupsBlocked, r => r.host);
	if (bad !== undefined) { return { name, ok: false, detail: `Row for ${bad} does not match the records` }; }
	return { name, ok: true };
}

export function checkProofBody(body: EgressProofBody): ProofCheck[] {
	return [
		checkChain(body.ledger),
		checkRows(body),
		body.scope === EGRESS_PROOF_SCOPE ? { name: 'Scope statement present', ok: true } : { name: 'Scope statement present', ok: false, detail: 'Scope statement is missing or changed' },
	];
}
