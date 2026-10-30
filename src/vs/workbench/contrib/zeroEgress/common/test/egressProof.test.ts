/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GENESIS_HASH, chainHash } from '../auditTypes.js';
import { LedgerBody, LedgerRecord } from '../egressLedger.js';
import { EGRESS_PROOF_SCOPE, EGRESS_PROOF_SIGNATURE_LIMIT, EgressSummaryAccumulator, buildEgressProof, canonicalProof, checkProofBody } from '../egressProof.js';

suite('EgressProof', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const H = (h: number) => new Date(Date.UTC(2026, 9, 30, h)).toISOString();
	const input = {
		createdAt: H(12),
		period: { from: H(0), to: H(12) },
		identity: { machineId: 'm', user: 'u', version: '1.0', commit: 'abc', os: 'darwin', networkSettings: [] },
		modelUsage: null,
		key: { publicKey: 'pk', fingerprint: 'fp', storage: 'file' as const },
	};

	function chain(bodies: LedgerBody[], startSeq = 1): LedgerRecord[] {
		const out: LedgerRecord[] = [];
		let prev = GENESIS_HASH;
		bodies.forEach((body, i) => {
			const seq = startSeq + i;
			out.push({ seq, prevHash: prev, body });
			prev = chainHash(prev, { seq, body: JSON.parse(JSON.stringify(body)) });
		});
		return out;
	}
	const allowed = (hour: number, dest: string, origin: 'main' | 'renderer', count: number, reason = 'audit collector'): LedgerBody =>
		({ type: 'allowed', hour: H(hour), dest, kind: 'internet', reason, origin, count });

	test('rows aggregate across hours and origins', () => {
		const p = buildEgressProof(chain([
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			allowed(1, 'b.example:443', 'main', 2),
			allowed(2, 'a.example:443', 'renderer', 3),
			allowed(3, 'a.example:443', 'main', 4, 'MCP server'),
			{ type: 'blocked', minute: H(2), dest: 'x.example:80', origin: 'main', count: 5 },
			{ type: 'blocked_lookup', minute: H(2), host: 'x.example', origin: 'renderer', count: 1 },
			{ type: 'session_end', time: H(4) },
		]), input);
		assert.deepStrictEqual(p.allowed, [
			{ dest: 'a.example:443', kind: 'internet', reasons: ['MCP server', 'audit collector'], origins: ['main', 'renderer'], count: 7, first: H(2), last: H(3) },
			{ dest: 'b.example:443', kind: 'internet', reasons: ['audit collector'], origins: ['main'], count: 2, first: H(1), last: H(1) },
		]);
		assert.deepStrictEqual(p.blocked, [{ dest: 'x.example:80', origins: ['main'], count: 5, first: H(2), last: H(2) }]);
		assert.deepStrictEqual(p.lookupsBlocked, [{ host: 'x.example', origins: ['renderer'], count: 1, first: H(2), last: H(2) }]);
		assert.strictEqual(p.ledger.firstSeq, 1);
		assert.strictEqual(p.ledger.headSeq, 7);
		assert.strictEqual(p.ledger.prevHashBeforeFirst, GENESIS_HASH);
	});

	test('crash leaves a gap', () => {
		const p = buildEgressProof(chain([
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			{ type: 'heartbeat', hour: H(1) },
			{ type: 'heartbeat', hour: H(2) },
			{ type: 'session_start', time: H(5), version: '1', commit: 'c' },
			{ type: 'heartbeat', hour: H(5) },
			{ type: 'session_end', time: H(6) },
		]), input);
		assert.deepStrictEqual(p.coverage.gaps, [{ from: H(2), to: H(5), why: 'crash' }]);
		assert.strictEqual(p.coverage.hoursRecorded, 3);
		assert.strictEqual(p.verdict, 'gaps');
	});

	test('reset leaves a gap', () => {
		const records = chain([{ type: 'heartbeat', hour: H(4) }]);
		const p = buildEgressProof(records, { ...input, resetSince: H(3) });
		assert.deepStrictEqual(p.coverage.gaps, [{ from: H(0), to: H(3), why: 'reset' }]);
		assert.strictEqual(p.verdict, 'gaps');
		assert.deepStrictEqual(buildEgressProof(records, { ...input, resetSince: H(0) }).coverage.gaps, []);
	});

	test('no gaps is ok', () => {
		const p = buildEgressProof(chain([
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			{ type: 'heartbeat', hour: H(1) },
			{ type: 'session_end', time: H(2) },
		]), input);
		assert.strictEqual(p.verdict, 'ok');
		assert.deepStrictEqual(p.coverage.gaps, []);
		assert.ok(checkProofBody(p).every(c => c.ok));
	});

	test('edited count fails row recompute', () => {
		const p = buildEgressProof(chain([allowed(1, 'a.example:443', 'main', 5)]), input);
		p.allowed[0].count = 1;
		const checks = checkProofBody(p);
		assert.strictEqual(checks[0].ok, true);
		assert.strictEqual(checks[1].name, 'Every row recomputes from the records');
		assert.strictEqual(checks[1].ok, false);
		assert.ok(checks[1].detail!.includes('a.example:443'));
	});

	test('removed record breaks the chain check', () => {
		const p = buildEgressProof(chain([
			allowed(1, 'a.example:443', 'main', 1),
			allowed(2, 'b.example:443', 'main', 1),
			allowed(3, 'c.example:443', 'main', 1),
		]), input);
		p.ledger.records.splice(1, 1);
		const checks = checkProofBody(p);
		assert.strictEqual(checks[0].name, 'Records form an unbroken chain');
		assert.strictEqual(checks[0].ok, false);
	});

	test('canonical form ignores key order', () => {
		const p = buildEgressProof(chain([allowed(1, 'a.example:443', 'main', 1)]), input);
		const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(p).reverse())));
		assert.strictEqual(canonicalProof(reordered), canonicalProof(p));
		assert.strictEqual(canonicalProof({ ...p, signature: 'x' } as never), canonicalProof(p));
	});

	test('scope copy is exact', () => {
		assert.strictEqual(EGRESS_PROOF_SCOPE, 'Covers connections made by ZeroEgress itself. Programs it starts (git, terminal and agent commands, language servers) are not covered.');
		assert.strictEqual(EGRESS_PROOF_SIGNATURE_LIMIT, 'A valid signature proves this report wasn\'t changed and was made with this device\'s key. It does not prove the machine itself wasn\'t tampered with.');
		const p = buildEgressProof([], input);
		assert.strictEqual(p.scope, EGRESS_PROOF_SCOPE);
		assert.ok(checkProofBody(p).every(c => c.ok));
	});

	test('edited body with the same seq fails the chain hash', () => {
		const p = buildEgressProof(chain([allowed(1, 'a.example:443', 'main', 1), allowed(2, 'b.example:443', 'main', 1)]), input);
		(p.ledger.records[0].body as { count: number }).count = 9;
		const c = checkProofBody(p)[0];
		assert.strictEqual(c.ok, false);
		assert.ok(c.detail!.includes('Record 2'));
	});

	test('broken chain leaves a gap at the record time', () => {
		const records = chain([allowed(1, 'a.example:443', 'main', 1), allowed(2, 'b.example:443', 'main', 1)]);
		assert.deepStrictEqual(buildEgressProof(records, { ...input, brokenAtSeq: 2 }).coverage.gaps, [{ from: H(2), why: 'chain' }]);
		assert.deepStrictEqual(buildEgressProof(records, { ...input, brokenAtSeq: 9 }).coverage.gaps, [{ from: H(0), why: 'chain' }]);
	});

	test('reset gap is clamped to the period end', () => {
		const p = buildEgressProof([], { ...input, resetSince: H(20) });
		assert.deepStrictEqual(p.coverage.gaps, [{ from: H(0), to: H(12), why: 'reset' }]);
	});

	test('crash is found when records start mid-session', () => {
		const p = buildEgressProof(chain([
			{ type: 'heartbeat', hour: H(1) },
			{ type: 'heartbeat', hour: H(2) },
			{ type: 'session_start', time: H(5), version: '1', commit: 'c' },
		]), input);
		assert.deepStrictEqual(p.coverage.gaps, [{ from: H(2), to: H(5), why: 'crash' }]);
	});

	test('empty records need zero seqs', () => {
		const p = buildEgressProof([], input);
		p.ledger.headSeq = 4;
		assert.strictEqual(checkProofBody(p)[0].ok, false);
	});

	test('coverage check catches edited hours, a deleted crash gap and a wrong verdict', () => {
		const crash = chain([
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			{ type: 'heartbeat', hour: H(1) },
			{ type: 'session_start', time: H(5), version: '1', commit: 'c' },
		]);
		const name = 'Coverage recomputes from the records';
		const good = buildEgressProof(crash, input);
		const ok = checkProofBody(good);
		assert.deepStrictEqual(ok.map(c => c.name), ['Records form an unbroken chain', 'Every row recomputes from the records', name, 'Scope statement present']);
		assert.ok(ok.every(c => c.ok));

		const hours = buildEgressProof(crash, input);
		hours.coverage.hoursRecorded = 9;
		assert.strictEqual(checkProofBody(hours)[2].ok, false);

		const noGap = buildEgressProof(crash, input);
		noGap.coverage.gaps = [];
		noGap.verdict = 'ok';
		assert.strictEqual(checkProofBody(noGap)[2].ok, false);

		const verdict = buildEgressProof(crash, input);
		verdict.verdict = 'ok';
		assert.strictEqual(checkProofBody(verdict)[2].ok, false);

		const reset = buildEgressProof(crash, { ...input, resetSince: H(3) });
		assert.strictEqual(checkProofBody(reset)[2].ok, true);
	});

	test('recordingSince is stated only when the ledger began after the period start, and must be well-formed', () => {
		const records = chain([{ type: 'session_start', time: H(3), version: '1', commit: 'c' }, { type: 'session_end', time: H(4) }]);
		assert.strictEqual(buildEgressProof(records, { ...input, recordingSince: H(0) }).coverage.recordingSince, undefined);
		assert.ok(!('recordingSince' in buildEgressProof(records, input).coverage));
		const late = buildEgressProof(records, { ...input, recordingSince: H(3) });
		assert.strictEqual(late.coverage.recordingSince, H(3));
		assert.strictEqual(late.verdict, 'ok', 'a late start alone is not a gap');
		assert.ok(checkProofBody(late).every(c => c.ok));
		late.coverage.recordingSince = 'yesterday';
		assert.deepStrictEqual(checkProofBody(late).find(c => !c.ok)?.detail, 'The recording start is malformed');
	});

	suite('EgressSummaryAccumulator', () => {
		const bodies: LedgerBody[] = [
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			allowed(1, 'a.example:443', 'main', 2),
			{ type: 'blocked', minute: H(1), dest: 'x.example:80', origin: 'main', count: 5 },
			{ type: 'session_start', time: H(2), version: '1', commit: 'c' }, // crash before it
			allowed(2, 'b.example:443', 'main', 1),
			{ type: 'blocked_lookup', minute: H(2), host: 'x.example', origin: 'renderer', count: 2 },
			{ type: 'session_end', time: H(3) },
		];

		test('fed in batches, it matches a full build', () => {
			const records = chain(bodies);
			const acc = new EgressSummaryAccumulator();
			acc.add(records.slice(0, 2));
			acc.add(records.slice(2, 5));
			acc.add([]);
			acc.add(records.slice(5));
			const full = buildEgressProof(records, input);
			const r = acc.result([], { chainOk: true });
			assert.strictEqual(r.destinations, full.allowed.length);
			assert.strictEqual(r.blocked, full.blocked.reduce((n, x) => n + x.count, 0) + full.lookupsBlocked.reduce((n, x) => n + x.count, 0));
			assert.strictEqual(r.verdict, full.verdict);
			assert.strictEqual(r.verdict, 'gaps');
			assert.strictEqual(acc.lastSeq, full.ledger.headSeq);
			assert.strictEqual(acc.lastHash, full.ledger.headHash);
			assert.strictEqual(acc.brokenAtSeq, undefined);
		});

		test('a reset, a broken chain, or a batch that does not link gives gaps', () => {
			const clean = chain([bodies[0], bodies[1], bodies[6]]);
			const acc = new EgressSummaryAccumulator();
			acc.add(clean);
			assert.strictEqual(acc.result([], { chainOk: true }).verdict, 'ok');
			assert.strictEqual(acc.result([], { chainOk: true, resetSince: H(1) }).verdict, 'gaps');
			assert.strictEqual(acc.result([], { chainOk: false }).verdict, 'gaps');
			acc.add(chain([{ type: 'heartbeat', hour: H(5) }], 5)); // seq 5 after 3, and a prevHash that is not the last hash
			assert.strictEqual(acc.brokenAtSeq, 4);
		});

		test('held counts are included without being kept', () => {
			const acc = new EgressSummaryAccumulator();
			acc.add(chain([bodies[0], bodies[1]]));
			const held: LedgerBody[] = [allowed(4, 'c.example:443', 'main', 1), allowed(4, 'a.example:443', 'main', 1), { type: 'blocked', minute: H(4), dest: 'y:1', origin: 'main', count: 3 }];
			assert.deepStrictEqual(acc.result(held, { chainOk: true }), { destinations: 2, blocked: 3, verdict: 'ok' });
			assert.deepStrictEqual(acc.result([], { chainOk: true }), { destinations: 1, blocked: 0, verdict: 'ok' });
		});
	});
});
