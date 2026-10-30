/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The pure parts of the main-process Egress Proof service (no electron), so they can be unit-tested.

import * as path from 'path';
import { createHash } from 'crypto';
import { LedgerRecord } from '../../common/egressLedger.js';
import { EgressTarget } from '../../common/egressPolicy.js';
import { EgressProofBody, ProofCheck, canonicalProof, checkProofBody } from '../../common/egressProof.js';
import { EgressProofKey } from './egressProofKey.js';

const DAY_MS = 24 * 3600_000;

export type ReportPeriodOptions = { days: number } | { from: string; to: string };

export const ON_MACHINE_CHECK = 'This machine\'s ledger contains this report';

/** `<folder>/egress-proof-<date>`, or `-2`, `-3`… when a .json or .pdf with that name already exists. Never overwrites. */
export function reportBasePath(folder: string, date: string, exists: (p: string) => boolean): string {
	for (let n = 1; ; n++) {
		const base = path.join(folder, `egress-proof-${date}${n === 1 ? '' : `-${n}`}`);
		if (!exists(`${base}.json`) && !exists(`${base}.pdf`)) { return base; }
	}
}

export function periodOf(opts: ReportPeriodOptions, now: number): { from: string; to: string } {
	if ('days' in opts) {
		if (!(typeof opts.days === 'number' && opts.days > 0 && isFinite(opts.days))) { throw new Error(`Invalid report period: ${opts.days} days`); }
		return { from: new Date(now - opts.days * DAY_MS).toISOString(), to: new Date(now).toISOString() };
	}
	const from = Date.parse(opts.from);
	const to = Date.parse(opts.to);
	if (isNaN(from) || isNaN(to) || from >= to) { throw new Error('Invalid report period: the start must be before the end'); }
	return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Intervals within the period when the audit log was on, from the `audit_state` records and the state at the period's start. */
export function auditCoverage(records: LedgerRecord[], period: { from: string; to: string }, enabledAtStart: boolean): { from: string; to: string }[] {
	const out: { from: string; to: string }[] = [];
	let onSince: string | undefined = enabledAtStart ? period.from : undefined;
	for (const { body } of records) {
		if (body.type !== 'audit_state' || body.time < period.from || body.time > period.to) { continue; }
		if (body.enabled && onSince === undefined) { onSince = body.time; }
		else if (!body.enabled && onSince !== undefined) {
			if (body.time > onSince) { out.push({ from: onSince, to: body.time }); }
			onSince = undefined;
		}
	}
	if (onSince !== undefined && period.to > onSince) { out.push({ from: onSince, to: period.to }); }
	return out;
}

/** The last audit state recorded in `records`, if any. */
export function lastAuditState(records: LedgerRecord[]): boolean | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const b = records[i].body;
		if (b.type === 'audit_state') { return b.enabled; }
	}
	return undefined;
}

/** Largest report JSON or PDF that verify will read, so a huge file can't exhaust main. */
export const MAX_REPORT_FILE_BYTES = 64 * 1024 * 1024;

/** Why a file can't be read for verify (not a regular file, or too big), or undefined when it can. */
export function reportFileProblem(stat: { isFile(): boolean; size: number }, max = MAX_REPORT_FILE_BYTES): string | undefined {
	if (!stat.isFile()) { return 'Not a regular file'; }
	if (stat.size > max) { return `The file is larger than ${Math.round(max / (1024 * 1024))} MB`; }
	return undefined;
}

export function targetLabel(t: EgressTarget): string {
	const dest = t.host.includes(':') ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`;
	return t.reason ? `${dest} (${t.reason})` : dest;
}

export interface ThisMachineLedger {
	machineId: string;
	hashAt(seq: number): Promise<string | undefined>;
	verifyChain(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>;
}

function malformed(v: any): string | undefined {
	const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
	if (!isObj(v)) { return 'The file is not a JSON object'; }
	if (v.schemaVersion !== 1) { return `Unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}; expected 1`; }
	const need: [string, boolean][] = [
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

/**
 * All checks for a report, in order: signature, the four body checks, the PDF (if given), and, for a report this machine
 * made whose head is still in its ledger, the on-machine check. An unreadable file gives one failed check.
 */
export async function verifyReportText(jsonText: string, pdf: Uint8Array | undefined, machine: ThisMachineLedger | undefined): Promise<ProofCheck[]> {
	let parsed: any;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return [{ name: 'Report file is readable', ok: false, detail: 'The file is not valid JSON' }];
	}
	const why = malformed(parsed);
	if (why) { return [{ name: 'Report file is readable', ok: false, detail: why }]; }
	const body = parsed as EgressProofBody & { signature?: unknown };

	const checks: ProofCheck[] = [];
	const signature = body.signature;
	checks.push(typeof signature !== 'string'
		? { name: 'Signature valid', ok: false, detail: 'The report has no signature' }
		: EgressProofKey.verify(body.key.publicKey, canonicalProof(body), signature)
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

	if (machine && body.identity.machineId === machine.machineId && typeof body.ledger.headSeq === 'number') {
		const hash = await machine.hashAt(body.ledger.headSeq);
		if (hash !== undefined) {
			const chain = await machine.verifyChain();
			checks.push(hash !== body.ledger.headHash
				? { name: ON_MACHINE_CHECK, ok: false, detail: `This machine's ledger has a different record at seq ${body.ledger.headSeq}` }
				: !chain.ok
					? { name: ON_MACHINE_CHECK, ok: false, detail: `This machine's ledger chain is broken at seq ${chain.brokenAtSeq}` }
					: { name: ON_MACHINE_CHECK, ok: true });
		}
	}
	return checks;
}
