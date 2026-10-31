/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The Egress Proof PDF, as one self-contained HTML document (inline CSS, no scripts, no external URLs).
// Main prints it with printToPDF in a hidden window with JavaScript off. Every value is HTML-escaped.

import { EgressOrigin } from './egressLedger.js';
import { EGRESS_PROOF_SCOPE, EGRESS_PROOF_SIGNATURE_LIMIT, EgressProofBody, EgressProofGap } from './egressProof.js';

export const EGRESS_PROOF_VERIFY_COMMAND = 'node verify-egress-proof.mjs <file>';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function esc(v: unknown): string {
	return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function num(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(n: number, one: string, many: string): string {
	return `${num(n)} ${n === 1 ? one : many}`;
}

// All dates are UTC, so the same report renders the same anywhere.
function day(iso: string): string {
	const d = new Date(iso);
	return isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function dayYear(iso: string): string {
	const d = new Date(iso);
	return isNaN(d.getTime()) ? iso : `${day(iso)} ${d.getUTCFullYear()}`;
}
function dateTime(iso: string): string {
	const d = new Date(iso);
	return isNaN(d.getTime()) ? iso : `${dayYear(iso)} ${iso.slice(11, 16)} UTC`;
}

function firstLast(first: string, last: string): string {
	return day(first) === day(last) ? day(first) : `${day(first)} / ${day(last)}`;
}

const ORIGIN_LABEL: Record<EgressOrigin, string> = {
	renderer: 'window',
	main: 'main process',
	extensionHost: 'extension host',
	sharedProcess: 'shared process',
};
const origins = (o: EgressOrigin[]) => o.map(x => ORIGIN_LABEL[x] ?? x).join(', ');

function short(v: string, head = 6, tail = 4): string {
	return v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;
}

function gapText(g: EgressProofGap): string {
	switch (g.why) {
		case 'crash': return `${dateTime(g.from)} to ${g.to ? dateTime(g.to) : 'now'}: the app stopped without closing the ledger. Connections after its last record are unknown.`;
		case 'reset': return `${dateTime(g.from)} to ${g.to ? dateTime(g.to) : 'now'}: the ledger was deleted or reset, so this time is not recorded.`;
		case 'chain': return `From ${dateTime(g.from)}: the ledger's record chain is broken.`;
		default: return String(g.why); // escaped by the caller
	}
}

function table(head: string[], rows: string[][], empty: string): string {
	if (rows.length === 0) { return `<p class="muted">${esc(empty)}</p>`; }
	const th = head.map(h => `<th>${esc(h)}</th>`).join('');
	const tr = rows.map(r => `<tr>${r.join('')}</tr>`).join('\n');
	return `<table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}
const td = (v: string, cls?: string) => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;

function modelUsageSection(mu: EgressProofBody['modelUsage'], period: EgressProofBody['period']): string {
	if (mu === null) {
		return `<p class="muted">Not included: the audit log was not enabled for this period, or model usage was left out of this report, so per-request records aren't shown. Connection counts above still apply.</p>`;
	}
	const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a));
	const covered = mu.auditCoverage.reduce((s, c) => s + ms(c.from, c.to), 0);
	const total = ms(period.from, period.to);
	const days = (n: number) => Math.round(n / 86_400_000 * 10) / 10;
	const ranges = mu.auditCoverage.map(c => `${day(c.from)} – ${day(c.to)}`).join(', ');
	const coverage = covered >= total
		? 'Audit log on for the whole period.'
		: `Audit log on for ${days(covered)} of ${days(total)} days (${ranges}); counts cover that time only.`;
	return `<p class="muted">${esc(coverage)}</p>` + table(
		['Provider', 'Model', 'Requests'],
		mu.byModel.map(m => [td(m.provider), td(m.model, 'mono'), td(num(m.requests))]),
		'No model requests were recorded.');
}

export function renderProofHtml(body: EgressProofBody): string {
	const blockedTotal = body.blocked.reduce((s, r) => s + r.count, 0) + body.lookupsBlocked.reduce((s, r) => s + r.count, 0);
	const blockedLine = blockedTotal === 0 ? 'No other attempts were blocked.' : `${plural(blockedTotal, 'other attempt was', 'other attempts were')} blocked.`;
	const ok = body.verdict === 'ok';
	const nothing = body.allowed.length === 0 && blockedTotal === 0;
	const verdict = nothing
		? (ok ? 'No connections were recorded in this period.' : 'No connections were recorded in this period, and the record has gaps (listed below).')
		: ok
			? `Every recorded connection in this period went to an allowed destination. ${blockedLine}`
			: `Every recorded connection in this period went to an allowed destination, but the record has gaps (listed below). ${blockedLine}`;
	const since = body.coverage.recordingSince;
	const started = since !== undefined ? ` Recording started ${dayYear(since)}; nothing before it is covered.` : '';
	const coverage = body.coverage.gaps.length === 0
		? `Coverage: the ledger recorded ${plural(body.coverage.hoursRecorded, 'hour', 'hours')} of the app being open in this period.${started} No gaps.`
		: `Coverage: the ledger recorded ${plural(body.coverage.hoursRecorded, 'hour', 'hours')} of the app being open in this period.${started} Gaps:`;
	const gaps = body.coverage.gaps.length === 0 ? '' : `<ul>${body.coverage.gaps.map(g => `<li>${esc(gapText(g))}</li>`).join('')}</ul>`;
	const id = body.identity;
	const intact = !body.coverage.gaps.some(g => g.why === 'chain');
	const { ledger, key } = body;
	const records = ledger.records.length === 0
		? 'no records in this period'
		: `${plural(ledger.records.length, 'record', 'records')} (seq ${ledger.firstSeq}–${ledger.headSeq}) · chain head ${short(ledger.headHash)} · ${intact ? 'intact' : 'broken'}`;
	const storage = key.storage === 'safeStorage'
		? 'private key encrypted by the operating system'
		: 'private key stored as an owner-only file (operating system encryption was not available)';

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>ZeroEgress Egress Proof ${esc(body.createdAt.slice(0, 10))}</title>
<style>
	@page { size: A4; margin: 16mm 14mm; }
	body { margin: 0; color: #1d2330; background: #fff; font: 11.5px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; }
	.top { display: flex; align-items: baseline; gap: 12px; }
	.title { font-size: 17px; font-weight: 700; }
	.sp { flex: 1; }
	.muted { color: #6b7280; }
	.verdict { margin-top: 12px; border-radius: 4px; padding: 7px 10px; font-weight: 600; }
	.verdict.ok { background: #e3f5ec; border: 1px solid #9fd8bb; color: #11633e; }
	.verdict.gaps { background: #fdf3df; border: 1px solid #f0d08a; color: #7a5300; }
	.scope { margin-top: 4px; font-size: 10.5px; }
	.coverage { margin-top: 6px; border-radius: 4px; padding: 4px 8px; font-size: 11px; }
	.coverage.ok { background: #f1f7f3; border: 1px solid #cfe7da; color: #285c40; }
	.coverage.gaps { background: #fdf3df; border: 1px solid #f0d08a; color: #7a5300; }
	.coverage ul { margin: 2px 0 0; padding-left: 18px; }
	h2 { margin: 16px 0 4px; font-size: 13px; border-bottom: 1px solid #d7d7d2; padding-bottom: 2px; }
	table { width: 100%; border-collapse: collapse; font-size: 11px; }
	th, td { text-align: left; vertical-align: top; padding: 2px 4px; border-bottom: 1px solid #e4e4df; }
	th { color: #6b7280; font-weight: 500; }
	tr { page-break-inside: avoid; }
	.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; word-break: break-all; }
	.facts td:first-child { width: 1%; white-space: nowrap; padding-right: 12px; }
	.limit { margin-top: 6px; font-size: 10.5px; }
</style></head>
<body>
<div class="top"><span class="title">ZeroEgress · Egress Proof</span><span class="sp"></span><span class="muted">report ${esc(body.createdAt.slice(0, 10))} · ${esc(day(body.period.from))} – ${esc(dayYear(body.period.to))}</span></div>
<div class="muted">Machine ${esc(short(id.machineId, 4, 3))} · user ${esc(id.user)} · ZeroEgress ${esc(id.version)} (commit ${esc(id.commit.slice(0, 10))}) · ${esc(id.os)}</div>
<div class="verdict ${ok ? 'ok' : 'gaps'}">${esc(verdict)}</div>
<div class="scope muted">${esc(body.scope || EGRESS_PROOF_SCOPE)}</div>
<div class="coverage ${ok ? 'ok' : 'gaps'}">${esc(coverage)}${gaps}</div>

<h2>Allowed destinations</h2>
${table(['Destination', 'Kind', 'Why allowed', 'From', 'Connections', 'First / last'],
		body.allowed.map(r => [td(r.dest, 'mono'), td(r.kind), td(r.reasons.join('; ')), td(origins(r.origins)), td(num(r.count)), td(firstLast(r.first, r.last))]),
		'No connections were recorded in this period.')}

<h2>Blocked attempts</h2>
${table(['Destination', 'From', 'Attempts', 'First / last'],
			body.blocked.map(r => [td(r.dest, 'mono'), td(origins(r.origins)), td(num(r.count)), td(firstLast(r.first, r.last))]),
			'No connection attempts were blocked.')}

<h2>Name lookups blocked</h2>
${table(['Host', 'From', 'Lookups', 'First / last'],
				body.lookupsBlocked.map(r => [td(r.host, 'mono'), td(origins(r.origins)), td(num(r.count)), td(firstLast(r.first, r.last))]),
				'No name lookups were blocked.')}

<h2>Model usage</h2>
${modelUsageSection(body.modelUsage, body.period)}

<h2>Integrity</h2>
<table class="facts"><tbody>
<tr><td>Period</td><td class="mono">${esc(body.period.from)} – ${esc(body.period.to)}</td></tr>
<tr><td>Ledger records</td><td class="mono">${esc(records)}</td></tr>
<tr><td>Allowed by settings</td><td class="mono">${esc(id.networkSettings.length ? id.networkSettings.join(', ') : 'none (this machine only)')}</td></tr>
<tr><td>Signed by</td><td class="mono">device key ed25519 ${esc(key.fingerprint)} · ${esc(dateTime(body.createdAt))}</td></tr>
<tr><td>Public key</td><td class="mono">${esc(key.publicKey)}</td></tr>
<tr><td>Key storage</td><td>${esc(storage)}</td></tr>
<tr><td>Check it yourself</td><td class="mono">${esc(EGRESS_PROOF_VERIFY_COMMAND)}</td></tr>
</tbody></table>
<p class="limit muted">${esc(EGRESS_PROOF_SIGNATURE_LIMIT)}</p>
<p class="muted">The JSON file next to this PDF holds the same rows, the ledger records they come from and the signature. Times are UTC.</p>
</body></html>
`;
}
