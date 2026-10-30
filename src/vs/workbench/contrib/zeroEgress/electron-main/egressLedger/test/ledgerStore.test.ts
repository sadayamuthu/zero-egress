/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LedgerStore } from '../ledgerStore.js';
import { LedgerBody } from '../../../common/egressLedger.js';
import { GENESIS_HASH, computeRecordHash, chainHash } from '../../../common/auditTypes.js';

function allowed(hour: string, dest = 'api.example.com:443'): LedgerBody {
	return { type: 'allowed', hour, dest, kind: 'internet', reason: 'model server (set in Settings)', origin: 'main', count: 1 };
}

let tmpDir: string;
let dbPath: string;
let store: LedgerStore;

suite('LedgerStore', () => {
	setup(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-ledger-'));
		dbPath = path.join(tmpDir, 'ledger.vscdb');
		store = await LedgerStore.create(dbPath);
	});
	teardown(async () => {
		await store.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function rawUpdate(sql: string, params: unknown[]): Promise<void> {
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		const db = await new Promise<InstanceType<typeof sqlite3.Database>>((resolve, reject) => {
			const d = new sqlite3.Database(dbPath, (err: Error | null) => err ? reject(err) : resolve(d));
		});
		await new Promise<void>((resolve, reject) => db.run(sql, params, (e: Error | null) => e ? reject(e) : resolve()));
		await new Promise<void>(resolve => db.close(() => resolve()));
	}

	test('appends chain and verify', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), { type: 'heartbeat', hour: '2026-07-12T02:00:00.000Z' }]);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		const recs = await store.recordsBetween('2026-07-12T00:00:00.000Z', '2026-07-12T23:00:00.000Z');
		assert.deepStrictEqual(recs.map(r => r.seq), [1, 2]);
		assert.strictEqual(recs[0].prevHash, GENESIS_HASH);
		assert.strictEqual(recs[1].prevHash, chainHash(recs[0].prevHash, { seq: 1, body: recs[0].body }));
	});

	test('head moves with each append', async () => {
		const h0 = await store.head();
		assert.deepStrictEqual(h0, { seq: 0, hash: GENESIS_HASH });
		await store.append([allowed('2026-07-12T01:00:00.000Z')]);
		const h1 = await store.head();
		await store.append([allowed('2026-07-12T02:00:00.000Z')]);
		const h2 = await store.head();
		assert.strictEqual(h1.seq, 1);
		assert.strictEqual(h2.seq, 2);
		assert.notStrictEqual(h1.hash, h2.hash);
		assert.match(h2.hash, /^[0-9a-f]{64}$/);
	});

	test('tampered row breaks the chain', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z'), allowed('2026-07-12T03:00:00.000Z')]);
		await rawUpdate(`UPDATE ledger_records SET json = ? WHERE seq = 2`, [JSON.stringify(allowed('2026-07-12T02:00:00.000Z', 'evil.example:443'))]);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 2 });
	});

	test('tampered head row breaks the chain', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z')]);
		await rawUpdate(`UPDATE ledger_records SET json = ? WHERE seq = 2`, [JSON.stringify(allowed('2026-07-12T02:00:00.000Z', 'evil.example:443'))]);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 2 });
	});

	test('prune keeps the chain verifiable', async () => {
		await store.append([allowed('2026-07-10T01:00:00.000Z'), allowed('2026-07-11T01:00:00.000Z'), allowed('2026-07-12T01:00:00.000Z')]);
		const removed = await store.pruneOlderThan('2026-07-12T00:00:00.000Z');
		assert.strictEqual(removed, 2);
		await store.append([allowed('2026-07-13T01:00:00.000Z')]);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		assert.strictEqual((await store.head()).seq, 4);
		await store.pruneOlderThan('2030-01-01T00:00:00.000Z');
		await store.append([allowed('2030-07-13T01:00:00.000Z')]);
		assert.strictEqual((await store.head()).seq, 5);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
	});

	test('prune of an out-of-order ledger deletes a contiguous prefix and still verifies', async () => {
		await store.append([
			allowed('2026-07-12T05:00:00.000Z'),
			allowed('2026-07-10T01:00:00.000Z'), // older than the cutoff but after a newer record
			allowed('2026-07-12T06:00:00.000Z'),
		]);
		const removed = await store.pruneOlderThan('2026-07-11T00:00:00.000Z');
		assert.strictEqual(removed, 0);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		await store.append([allowed('2026-07-01T00:00:00.000Z')]);
		assert.strictEqual(await store.pruneOlderThan('2026-07-12T05:30:00.000Z'), 2);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
	});

	test('tail truncation breaks the chain', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z'), allowed('2026-07-12T03:00:00.000Z')]);
		await rawUpdate(`DELETE FROM ledger_records WHERE seq = 3`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 3 });
	});

	test('a deleted middle row breaks the chain at that seq', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z'), allowed('2026-07-12T03:00:00.000Z')]);
		await rawUpdate(`DELETE FROM ledger_records WHERE seq = 2`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 2 });
	});

	test('deleting the oldest rows by hand breaks the chain', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z'), allowed('2026-07-12T03:00:00.000Z')]);
		await rawUpdate(`DELETE FROM ledger_records WHERE seq <= 2`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 1 });
	});

	test('deleting the oldest rows after a prune breaks the chain', async () => {
		await store.append([allowed('2026-07-10T01:00:00.000Z'), allowed('2026-07-11T01:00:00.000Z'), allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-13T01:00:00.000Z')]);
		assert.strictEqual(await store.pruneOlderThan('2026-07-11T00:00:00.000Z'), 1);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		await rawUpdate(`DELETE FROM ledger_records WHERE seq = 2`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 2 });
	});

	test('deleting every row by hand breaks the chain', async () => {
		assert.deepStrictEqual(await store.verifyChain(), { ok: true }, 'a new, empty ledger is intact');
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z')]);
		await rawUpdate(`DELETE FROM ledger_records`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 1 });
	});

	test('pruning every row is not a break, until a later row is deleted', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z')]);
		assert.strictEqual(await store.pruneOlderThan('2030-01-01T00:00:00.000Z'), 2);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		await store.append([allowed('2030-07-13T01:00:00.000Z')]);
		assert.deepStrictEqual(await store.verifyChain(), { ok: true });
		await rawUpdate(`DELETE FROM ledger_records`, []);
		assert.deepStrictEqual(await store.verifyChain(), { ok: false, brokenAtSeq: 3 });
	});

	test('recordsAfter returns later records in seq order', async () => {
		await store.append([allowed('2026-07-12T03:00:00.000Z'), allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z')]);
		assert.deepStrictEqual((await store.recordsAfter(1)).map(r => r.seq), [2, 3]);
		assert.deepStrictEqual(await store.recordsAfter(3), []);
	});

	test('recordsBetween filters by bucket time', async () => {
		await store.append([
			allowed('2026-07-12T01:00:00.000Z'),
			{ type: 'blocked', minute: '2026-07-12T02:05:00.000Z', dest: 'x.example:443', origin: 'main', count: 1 },
			{ type: 'session_end', time: '2026-07-12T05:00:00.000Z' },
		]);
		const recs = await store.recordsBetween('2026-07-12T02:00:00.000Z', '2026-07-12T03:00:00.000Z');
		assert.deepStrictEqual(recs.map(r => r.seq), [2]);
		assert.deepStrictEqual(await store.recordsBetween('2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'), []);
	});

	test('recordsBetween returns a contiguous seq range even when appended out of time order', async () => {
		await store.append([
			{ type: 'session_start', time: '2026-07-12T01:30:00.000Z', version: '1', commit: 'c' },
			{ type: 'heartbeat', hour: '2026-07-12T01:00:00.000Z' }, // earlier than the previous record
			allowed('2026-07-12T02:00:00.000Z'),
			{ type: 'heartbeat', hour: '2026-07-12T00:00:00.000Z' }, // earlier again
			{ type: 'session_end', time: '2026-07-12T03:00:00.000Z' },
		]);
		const recs = await store.recordsBetween('2026-07-12T01:30:00.000Z', '2026-07-12T03:00:00.000Z');
		assert.deepStrictEqual(recs.map(r => r.seq), [1, 2, 3, 4, 5]);
		const mid = await store.recordsBetween('2026-07-12T02:00:00.000Z', '2026-07-12T02:00:00.000Z');
		assert.deepStrictEqual(mid.map(r => r.seq), [3, 4]); // seq 4 has an earlier t but sits inside the min..max seq range
	});

	test('createdAt survives prune and reopen', async () => {
		const created = await store.createdAt();
		assert.ok(!isNaN(Date.parse(created)));
		await store.append([allowed('2026-07-10T01:00:00.000Z')]);
		await store.pruneOlderThan('2030-01-01T00:00:00.000Z');
		assert.strictEqual(await store.createdAt(), created);
		await store.close();
		store = await LedgerStore.create(dbPath);
		assert.strictEqual(await store.createdAt(), created);
	});

	test('hashAt returns the record hash for a seq', async () => {
		await store.append([allowed('2026-07-12T01:00:00.000Z'), allowed('2026-07-12T02:00:00.000Z'), allowed('2026-07-12T03:00:00.000Z')]);
		const recs = await store.recordsBetween('2026-07-12T00:00:00.000Z', '2026-07-12T23:00:00.000Z');
		assert.strictEqual(await store.hashAt(1), recs[1].prevHash);
		assert.strictEqual(await store.hashAt(2), recs[2].prevHash);
		assert.strictEqual(await store.hashAt(3), (await store.head()).hash);
		assert.strictEqual(await store.hashAt(4), undefined);
		await store.pruneOlderThan('2030-01-01T00:00:00.000Z');
		assert.strictEqual(await store.hashAt(1), undefined);
		assert.strictEqual(await store.hashAt(3), (await store.head()).hash);
	});

	test('audit hash unchanged', () => {
		const h = computeRecordHash(GENESIS_HASH, { seq: 1, id: 'a', n: [1, { z: 2, b: null }], t: 'x' } as never);
		assert.strictEqual(h, '8f234e1290e52303293b2176aa71627b5e929939e4bc6662b359d89b4378ddd9');
	});
});
