/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { GENESIS_HASH, chainHash } from '../../../common/auditTypes.js';
import { LedgerBody, LedgerRecord } from '../../../common/egressLedger.js';
import { buildEgressProof, canonicalProof } from '../../../common/egressProof.js';
import { EgressProofKey } from '../egressProofKey.js';
import { MAX_REPORT_FILE_BYTES, auditCoverage, periodOf, reportBasePath, reportFileProblem, summarySince, targetLabel, verifyReportText } from '../egressProofReport.js';

const H = (h: number) => new Date(Date.UTC(2026, 9, 30, h)).toISOString();

function chain(bodies: LedgerBody[]): LedgerRecord[] {
	let prev = GENESIS_HASH;
	return bodies.map((body, i) => {
		const rec = { seq: i + 1, prevHash: prev, body };
		prev = chainHash(prev, { seq: i + 1, body: JSON.parse(JSON.stringify(body)) });
		return rec;
	});
}

suite('EgressProofReport', () => {
	let dir: string;
	setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-proof-report-')); });
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	test('report file names never overwrite', () => {
		const exists = (p: string) => fs.existsSync(p);
		assert.strictEqual(reportBasePath(dir, '2026-10-30', exists), path.join(dir, 'egress-proof-2026-10-30'));
		fs.writeFileSync(path.join(dir, 'egress-proof-2026-10-30.json'), '');
		assert.strictEqual(reportBasePath(dir, '2026-10-30', exists), path.join(dir, 'egress-proof-2026-10-30-2'));
		fs.writeFileSync(path.join(dir, 'egress-proof-2026-10-30-2.pdf'), '');
		assert.strictEqual(reportBasePath(dir, '2026-10-30', exists), path.join(dir, 'egress-proof-2026-10-30-3'));
	});

	test('period from days or a range', () => {
		const now = Date.UTC(2026, 9, 30, 12);
		assert.deepStrictEqual(periodOf({ days: 7 }, now), { from: new Date(now - 7 * 24 * 3600_000).toISOString(), to: H(12) });
		assert.deepStrictEqual(periodOf({ from: H(1), to: H(2) }, now), { from: H(1), to: H(2) });
		assert.throws(() => periodOf({ from: H(2), to: H(1) }, now));
		assert.throws(() => periodOf({ days: 0 }, now));
	});

	test('audit coverage follows audit_state records', () => {
		const records = chain([
			{ type: 'audit_state', time: H(2), enabled: true },
			{ type: 'audit_state', time: H(4), enabled: false },
			{ type: 'audit_state', time: H(6), enabled: true },
			{ type: 'audit_state', time: H(7), enabled: true },
		]);
		assert.deepStrictEqual(auditCoverage(records, { from: H(0), to: H(10) }, false), [{ from: H(2), to: H(4) }, { from: H(6), to: H(10) }]);
		assert.deepStrictEqual(auditCoverage(records, { from: H(0), to: H(10) }, true), [{ from: H(0), to: H(4) }, { from: H(6), to: H(10) }]);
		assert.deepStrictEqual(auditCoverage([], { from: H(0), to: H(10) }, false), []);
	});

	test('report files must be regular and bounded', () => {
		const file = (size: number) => ({ isFile: () => true, size });
		assert.strictEqual(reportFileProblem(file(10)), undefined);
		assert.strictEqual(reportFileProblem(file(MAX_REPORT_FILE_BYTES)), undefined);
		assert.strictEqual(reportFileProblem(file(MAX_REPORT_FILE_BYTES + 1)), 'The file is larger than 64 MB');
		assert.strictEqual(reportFileProblem({ isFile: () => false, size: 0 }), 'Not a regular file');
		assert.strictEqual(reportFileProblem(fs.statSync(dir)), 'Not a regular file');
		if (process.platform !== 'win32') { assert.strictEqual(reportFileProblem(fs.statSync('/dev/zero')), 'Not a regular file'); }
	});

	test('summary since: a reset keeps the profile\'s start, so the reset falls inside the verdict', () => {
		assert.strictEqual(summarySince(H(5), undefined, H(1)), H(5));
		assert.strictEqual(summarySince(H(5), H(5), H(1)), H(1));
		assert.strictEqual(summarySince(H(5), H(5), undefined), H(5));
	});

	test('target labels', () => {
		assert.strictEqual(targetLabel({ host: '192.168.1.2', port: 8000, reason: 'MCP server' }), '192.168.1.2:8000 (MCP server)');
		assert.strictEqual(targetLabel({ host: '::1', port: 80 }), '[::1]:80');
	});

	suite('verifyReportText', () => {
		const records = chain([
			{ type: 'session_start', time: H(1), version: '1', commit: 'c' },
			{ type: 'allowed', hour: H(1), dest: 'a.example:443', kind: 'internet', reason: 'MCP server', origin: 'main', count: 3 },
			{ type: 'session_end', time: H(2) },
		]);
		const pdf = Buffer.from('%PDF-fake');

		function signed(dirForKey: string) {
			const key = EgressProofKey.load(dirForKey, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error(); }, decryptString: () => { throw new Error(); } });
			const body = buildEgressProof(records, {
				createdAt: H(3), period: { from: H(0), to: H(3) },
				identity: { machineId: 'm1', user: 'u', version: '1', commit: 'c', os: 'test', networkSettings: [] },
				modelUsage: null, key: { publicKey: key.publicKey, fingerprint: key.fingerprint, storage: key.storage },
			});
			body.pdfSha256 = createHash('sha256').update(pdf).digest('hex');
			return { ...body, signature: key.sign(canonicalProof(body)) };
		}
		const machine = (machineId: string, hash: string | undefined) => ({ machineId, hashAt: async () => hash, verifyChain: async () => ({ ok: true as const }) });

		test('good report: checks in order', async () => {
			const report = signed(dir);
			const { checks, fingerprint } = await verifyReportText(JSON.stringify(report), pdf, machine('m1', report.ledger.headHash));
			assert.strictEqual(fingerprint, report.key.fingerprint);
			assert.deepStrictEqual(checks.map(c => [c.name, c.ok]), [
				['Signature valid', true],
				['Fingerprint matches the public key', true],
				['Records form an unbroken chain', true],
				['Every row recomputes from the records', true],
				['Coverage recomputes from the records', true],
				['Scope statement present', true],
				['PDF matches JSON', true],
				['This machine\'s ledger contains this report', true],
			]);
		});

		test('tampering, another pdf and another ledger fail', async () => {
			const report = signed(dir);
			report.allowed[0].count = 1;
			const { checks } = await verifyReportText(JSON.stringify(report), Buffer.from('other'), machine('m1', 'different'));
			const failed = checks.filter(c => !c.ok).map(c => c.name);
			assert.deepStrictEqual(failed, ['Signature valid', 'Every row recomputes from the records', 'PDF matches JSON', 'This machine\'s ledger contains this report']);
		});

		test('on-machine check only when the head is in this ledger of this machine', async () => {
			const report = signed(dir);
			const names = async (m: ReturnType<typeof machine> | undefined, withPdf: boolean) =>
				(await verifyReportText(JSON.stringify(report), withPdf ? pdf : undefined, m)).checks.map(c => c.name);
			assert.ok(!(await names(machine('m1', undefined), true)).includes('This machine\'s ledger contains this report'));
			assert.ok(!(await names(machine('other', report.ledger.headHash), true)).includes('This machine\'s ledger contains this report'));
			assert.ok(!(await names(undefined, false)).includes('PDF matches JSON'));
		});

		test('unreadable report is one failed check', async () => {
			for (const text of ['not json', JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1 })]) {
				const { checks, fingerprint } = await verifyReportText(text, undefined, undefined);
				assert.strictEqual(fingerprint, undefined);
				assert.strictEqual(checks.length, 1);
				assert.strictEqual(checks[0].name, 'Report file is readable');
				assert.strictEqual(checks[0].ok, false);
				assert.ok(checks[0].detail);
			}
			assert.strictEqual((await verifyReportText('{"secret bytes', undefined, undefined)).checks[0].detail, 'The file is not valid JSON');
		});

		test('a report signed by another key that states this device\'s fingerprint fails the fingerprint check', async () => {
			const victim = signed(dir);
			const attackerDir = fs.mkdtempSync(path.join(dir, 'attacker-'));
			const attacker = EgressProofKey.load(attackerDir, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error(); }, decryptString: () => { throw new Error(); } });
			const { signature: _s, ...forged } = signed(attackerDir);
			forged.key = { ...forged.key, fingerprint: victim.key.fingerprint };
			const body = { ...forged, signature: attacker.sign(canonicalProof(forged)) }; // a valid signature by the attacker's own key
			const { checks, fingerprint } = await verifyReportText(JSON.stringify(body), pdf, undefined);
			assert.deepStrictEqual(checks.slice(0, 2).map(c => [c.name, c.ok]), [['Signature valid', true], ['Fingerprint matches the public key', false]]);
			assert.strictEqual(fingerprint, attacker.fingerprint, 'the fingerprint returned is the signing key\'s, not the stated one');
			assert.notStrictEqual(fingerprint, victim.key.fingerprint);
		});
	});
});
