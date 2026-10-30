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

	test('flush writes heartbeat and counts', async () => {
		service = await create();
		service.aggregator.addAllowed('https://api.example.com/v1?x=1', 'model server (set in Settings)', 'main', clock, 3);
		await service.flush();
		const b = await bodies();
		const allowed = b.find(x => x.type === 'allowed');
		assert.ok(allowed && allowed.type === 'allowed' && allowed.dest === 'api.example.com:443' && allowed.count === 3);
		const hb = b.filter(x => x.type === 'heartbeat');
		assert.strictEqual(hb.length, 1);
		assert.strictEqual((hb[0] as { hour: string }).hour, new Date(Math.floor(clock / 3600_000) * 3600_000).toISOString());
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
		await service.flush(); // must not throw
		assert.strictEqual(errors.length, 1);
		fail = false;
		service.aggregator.addAllowed('https://b.example.com/', 'model server (set in Settings)', 'main', clock);
		await service.flush();
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
		await svc.flush();
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
