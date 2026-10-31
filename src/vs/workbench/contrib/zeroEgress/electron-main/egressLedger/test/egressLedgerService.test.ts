/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EgressLedgerService } from '../egressLedgerService.js';
import { LedgerBody } from '../../../common/egressLedger.js';

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const FAR = '2000-01-01T00:00:00.000Z';
const FAR_END = '2999-01-01T00:00:00.000Z';

suite('EgressLedgerService', () => {
	let tmpDir: string;
	let dbPath: string;
	let service: EgressLedgerService | undefined;
	let marker: string | undefined;
	let clock: number;
	const expectedSince = { get: () => marker, set: (v: string) => { marker = v; } };

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-ledger-svc-'));
		dbPath = path.join(tmpDir, 'ledger.vscdb');
		marker = undefined;
		clock = Date.now();
	});
	teardown(async () => {
		await service?.dispose();
		service = undefined;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function create(auditEnabled = true, onError?: (m: string, e: unknown) => void) {
		return EgressLedgerService.create({ dbPath, version: '1.2.3', commit: 'abc', auditEnabled, expectedSince, now: () => clock, flushMs: 3_600_000, onError });
	}
	async function bodies(): Promise<LedgerBody[]> {
		return (await service!.store.recordsBetween(FAR, FAR_END)).map(r => r.body);
	}

	test('fresh ledger with no expectedSince marker starts clean', async () => {
		service = await create();
		assert.strictEqual(marker, await service.store.createdAt());
		assert.strictEqual(service.resetSince(), undefined);
		const b = await bodies();
		assert.deepStrictEqual(b.map(x => x.type), ['session_start', 'audit_state']);
	});

	test('ledger newer than expectedSince is a reset gap', async () => {
		marker = new Date(Date.now() - 10 * DAY).toISOString();
		service = await create();
		assert.strictEqual(service.resetSince(), await service.store.createdAt());
		assert.strictEqual(marker, new Date(marker).toISOString());
	});

	test('pruning everything older than 400 days does not create a reset', async () => {
		service = await create();
		const createdAt = await service.store.createdAt();
		await service.dispose();
		service = undefined;
		clock += 500 * DAY; // everything written so far is now older than 400 days
		service = await create();
		assert.strictEqual(await service.store.createdAt(), createdAt);
		assert.strictEqual(service.resetSince(), undefined);
		const types = (await bodies()).map(x => x.type);
		assert.ok(!types.includes('session_end'), 'old session_end was pruned');
	});

	test('flush writes the hour\'s heartbeat once, and counts only when their hour closes', async () => {
		clock = Math.floor(Date.now() / HOUR) * HOUR + 10 * 60_000; // 10 minutes into an hour
		const hour = new Date(Math.floor(clock / HOUR) * HOUR).toISOString();
		service = await create();
		service.aggregator.addAllowed('https://api.example.com/v1?x=1', 'model server (set in Settings)', 'main', clock, 3);
		await service.flush();
		let b = await bodies();
		assert.ok(!b.some(x => x.type === 'allowed'), 'the open hour\'s counts are held');
		assert.deepStrictEqual(b.filter(x => x.type === 'heartbeat'), [{ type: 'heartbeat', hour }]);
		assert.deepStrictEqual(service.heldCounts().map(x => (x as { count: number }).count), [3]);

		clock += 20 * 60_000; // same hour: no new heartbeat; counts merge into the held row
		service.aggregator.addAllowed('https://api.example.com/v2', 'model server (set in Settings)', 'main', clock, 2);
		await service.flush();
		b = await bodies();
		assert.strictEqual(b.filter(x => x.type === 'heartbeat').length, 1);
		assert.ok(!b.some(x => x.type === 'allowed'));

		clock += HOUR; // the hour closed: one row for it, and the new hour's heartbeat
		await service.flush();
		b = await bodies();
		const allowed = b.filter(x => x.type === 'allowed');
		assert.strictEqual(allowed.length, 1);
		assert.ok(allowed[0].type === 'allowed' && allowed[0].dest === 'api.example.com:443' && allowed[0].count === 5 && allowed[0].hour === hour);
		assert.deepStrictEqual(b.filter(x => x.type === 'heartbeat').map(x => (x as { hour: string }).hour), [hour, new Date(Date.parse(hour) + HOUR).toISOString()]);
		assert.deepStrictEqual(service.heldCounts(), []);
	});

	test('dispose writes the held counts of the open hour', async () => {
		service = await create();
		service.aggregator.addAllowed('https://api.example.com/', 'model server (set in Settings)', 'main', clock, 4);
		await service.flush();
		await service.dispose();
		service = await create();
		const allowed = (await bodies()).filter(x => x.type === 'allowed');
		assert.deepStrictEqual(allowed.map(x => (x as { count: number }).count), [4]);
	});

	test('flush(true) writes the open hour\'s counts, for a report up to now', async () => {
		service = await create();
		service.aggregator.addBlocked('https://evil.example/', 'renderer', clock);
		await service.flush(true);
		assert.deepStrictEqual((await bodies()).filter(x => x.type === 'blocked').map(x => (x as { count: number }).count), [1]);
		assert.deepStrictEqual(service.heldCounts(), []);
	});

	test('the 60 s flush still writes audit_state without waiting for the hour', async () => {
		service = await create(true);
		await service.flush();
		const before = (await bodies()).length;
		service.setAuditEnabled(false);
		await service.flush();
		const b = await bodies();
		assert.strictEqual(b.length, before + 1);
		assert.deepStrictEqual(b[b.length - 1], { type: 'audit_state', time: new Date(clock).toISOString(), enabled: false });
	});

	test('dispose writes session_end', async () => {
		service = await create();
		await service.flush();
		await service.dispose();
		service = await create();
		const b = await bodies();
		assert.ok(b.some(x => x.type === 'session_end'));
	});

	test('audit state changes are recorded', async () => {
		service = await create(true);
		service.setAuditEnabled(true); // unchanged: no record
		service.setAuditEnabled(false);
		await service.flush();
		const states = (await bodies()).filter(x => x.type === 'audit_state').map(x => (x as { enabled: boolean }).enabled);
		assert.deepStrictEqual(states, [true, false]);
	});

	test('a failing flush is logged and a later flush still works', async () => {
		const errors: string[] = [];
		service = await create(true, m => errors.push(m));
		const store = service.store;
		const original = store.append.bind(store);
		let fail = true;
		store.append = async (b: LedgerBody[]) => { if (fail) { throw new Error('disk full'); } return original(b); };
		service.aggregator.addAllowed('https://a.example.com/', 'model server (set in Settings)', 'main', clock);
		await service.flush(true); // must not throw
		assert.strictEqual(errors.length, 1);
		fail = false;
		service.aggregator.addAllowed('https://b.example.com/', 'model server (set in Settings)', 'main', clock);
		await service.flush(true);
		const dests = (await bodies()).filter(x => x.type === 'allowed').map(x => (x as { dest: string }).dest);
		assert.deepStrictEqual(dests, ['b.example.com:443']);
	});

	test('dispose called before open resolves still writes session_end and closes', async () => {
		const svc = new EgressLedgerService({ dbPath, version: '1', commit: 'c', auditEnabled: true, expectedSince, now: () => clock, flushMs: 3_600_000 });
		const opening = svc.open();
		await svc.dispose();
		await opening;
		await svc.flush(); // no-op after dispose
		service = await create();
		const types = (await bodies()).map(x => x.type);
		assert.deepStrictEqual(types.slice(0, 3), ['session_start', 'audit_state', 'session_end']);
	});

	test('counts added before open resolves are written after session_start', async () => {
		const svc = new EgressLedgerService({ dbPath, version: '1', commit: 'c', auditEnabled: true, expectedSince, now: () => clock, flushMs: 3_600_000 });
		svc.aggregator.addAllowed('https://early.example.com/', 'model server (set in Settings)', 'main', clock);
		await svc.open();
		await svc.flush(true);
		service = svc;
		const types = (await bodies()).map(x => x.type);
		assert.strictEqual(types[0], 'session_start');
		assert.ok(types.includes('allowed'));
	});

	test('audit_state survives a failed flush', async () => {
		service = await create(true, () => { });
		const store = service.store;
		const original = store.append.bind(store);
		let fail = true;
		store.append = async (b: LedgerBody[]) => { if (fail) { throw new Error('x'); } return original(b); };
		service.setAuditEnabled(false);
		await service.flush();
		fail = false;
		await service.flush();
		const states = (await bodies()).filter(x => x.type === 'audit_state').map(x => (x as { enabled: boolean }).enabled);
		assert.deepStrictEqual(states, [true, false]);
	});
});
