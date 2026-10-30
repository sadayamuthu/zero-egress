/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GENESIS_HASH, chainHash } from '../auditTypes.js';
import { LedgerBody, LedgerRecord } from '../egressLedger.js';
import { EGRESS_PROOF_SCOPE, EGRESS_PROOF_SIGNATURE_LIMIT, buildEgressProof } from '../egressProof.js';
import { renderProofHtml } from '../egressProofHtml.js';

suite('EgressProofHtml', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const H = (h: number) => new Date(Date.UTC(2026, 9, 30, h)).toISOString();

	function chain(bodies: LedgerBody[]): LedgerRecord[] {
		let prev = GENESIS_HASH;
		return bodies.map((body, i) => {
			const rec = { seq: i + 1, prevHash: prev, body };
			prev = chainHash(prev, { seq: i + 1, body: JSON.parse(JSON.stringify(body)) });
			return rec;
		});
	}

	function body(dest = '127.0.0.1:11434', blockedDest = 'marketplace.visualstudio.com:443') {
		return buildEgressProof(chain([
			{ type: 'session_start', time: H(1), version: '1.0', commit: 'abc' },
			{ type: 'allowed', hour: H(1), dest, kind: 'this machine', reason: 'this machine', origin: 'main', count: 1284 },
			{ type: 'blocked', minute: H(2), dest: blockedDest, origin: 'extensionHost', count: 7 },
			{ type: 'blocked_lookup', minute: H(2), host: 'telemetry.example', origin: 'renderer', count: 2 },
			{ type: 'heartbeat', hour: H(2) },
			{ type: 'session_end', time: H(3) },
		]), {
			createdAt: H(12),
			period: { from: H(0), to: H(12) },
			identity: { machineId: 'machine-1', user: 'karthik', version: '0.2.0', commit: 'abcdef1234', os: 'darwin 25.0.0', networkSettings: ['192.168.1.20:8000 (model server (set in Settings))'] },
			modelUsage: null,
			key: { publicKey: 'cHVibGljLWtleQ==', fingerprint: 'abcd-ef01-2345-6789', storage: 'file' },
		});
	}

	test('contains rows and exact copy', () => {
		const html = renderProofHtml({ ...body(), pdfSha256: undefined });
		assert.ok(html.startsWith('<!DOCTYPE html>'));
		assert.ok(html.includes('127.0.0.1:11434'));
		assert.ok(html.includes('1,284'));
		assert.ok(html.includes('marketplace.visualstudio.com:443'));
		assert.ok(html.includes('telemetry.example'));
		assert.ok(html.includes(EGRESS_PROOF_SCOPE.replace(/'/g, '&#39;')));
		assert.ok(html.includes(EGRESS_PROOF_SIGNATURE_LIMIT.replace(/'/g, '&#39;')));
		assert.ok(html.includes('node verify-egress-proof.mjs &lt;file&gt;'));
		assert.ok(html.includes('abcd-ef01-2345-6789'));
		assert.ok(html.includes('192.168.1.20:8000'));
		assert.ok(html.includes('Connection counts above still apply.'));
		assert.ok(html.includes('9 other attempts were blocked'));
	});

	test('verdict wording claims only what was recorded', () => {
		const html = renderProofHtml(body());
		assert.ok(html.includes('Every recorded connection in this period went to an allowed destination.'));
		assert.ok(!html.includes('Every connection'));
		assert.ok(!html.includes('Recording started'));
	});

	test('a period with no records says so', () => {
		const empty = buildEgressProof([], {
			createdAt: H(12), period: { from: H(0), to: H(12) },
			identity: { machineId: 'm', user: 'u', version: '1', commit: 'c', os: 'o', networkSettings: [] },
			modelUsage: null, key: { publicKey: 'cHVibGljLWtleQ==', fingerprint: 'abcd', storage: 'file' },
		});
		const html = renderProofHtml(empty);
		assert.ok(html.includes('No connections were recorded in this period.'));
		assert.ok(!html.includes('Every recorded connection'));
	});

	test('a ledger younger than the period states when recording started', () => {
		const late = buildEgressProof(chain([{ type: 'session_start', time: H(5), version: '1', commit: 'c' }, { type: 'session_end', time: H(6) }]), {
			createdAt: H(12), period: { from: H(0), to: H(12) },
			identity: { machineId: 'm', user: 'u', version: '1', commit: 'c', os: 'o', networkSettings: [] },
			modelUsage: null, recordingSince: H(5), key: { publicKey: 'cHVibGljLWtleQ==', fingerprint: 'abcd', storage: 'file' },
		});
		assert.strictEqual(late.coverage.recordingSince, H(5));
		assert.ok(renderProofHtml(late).includes('Recording started 30 Oct 2026; nothing before it is covered.'));
	});

	test('escapes values', () => {
		const html = renderProofHtml(body('<script>alert(1)</script>:1', '"><img src=x>:2'));
		assert.ok(!html.includes('<script>'));
		assert.ok(!html.includes('<img'));
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;:1'));
		assert.ok(html.includes('&quot;&gt;&lt;img src=x&gt;:2'));
	});

	test('has no external URLs', () => {
		const html = renderProofHtml(body());
		assert.ok(!/(src|href)\s*=\s*["']?\s*(https?:|\/\/)/i.test(html));
		assert.ok(!/url\(/i.test(html));
		assert.ok(!/<(script|link|img|iframe)\b/i.test(html));
	});
});
