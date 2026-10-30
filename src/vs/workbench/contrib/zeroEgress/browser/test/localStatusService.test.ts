/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runs under test-node by path (it uses no DOM): node test/unit/node/index.js --run <this file>

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EgressTarget } from '../../common/egressPolicy.js';
import { BlockedAttempt, IEgressGuardService } from '../../common/egressGuardService.js';
import { formatLocalStatus } from '../../common/localStatus.js';
import { IZeroEgressSettingsService } from '../../common/zeroEgressSettingsService.js';
import { LocalStatusService } from '../localStatusService.js';

suite('LocalStatusService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const target = (host: string, port: number): EgressTarget => ({ host, port });
	const flush = () => new Promise(r => setTimeout(r, 0));

	function create(opts: { recentBlocked?: number; targets?: () => Promise<EgressTarget[]> }) {
		const ds = store.add(new DisposableStore());
		const onDidBlock = ds.add(new Emitter<BlockedAttempt>());
		const onDidChangeTargets = ds.add(new Emitter<EgressTarget[]>());
		const onDidChangeState = ds.add(new Emitter<void>());
		let getTargetsCalls = 0;
		const guard = {
			onDidBlock: onDidBlock.event,
			onDidChangeTargets: onDidChangeTargets.event,
			getRecentBlocked: async () => new Array(opts.recentBlocked ?? 0).fill({}),
			getTargets: () => { getTargetsCalls++; return opts.targets ? opts.targets() : Promise.resolve([]); },
		} as unknown as IEgressGuardService;
		const settings = { onDidChangeState: onDidChangeState.event } as unknown as IZeroEgressSettingsService;
		const service = ds.add(new LocalStatusService(guard, settings));
		let changes = 0;
		ds.add(service.onDidChange(() => changes++));
		return { service, onDidBlock, onDidChangeTargets, onDidChangeState, changes: () => changes, getTargetsCalls: () => getTargetsCalls };
	}

	test('counts the blocked log so far plus each new block', async () => {
		const { service, onDidBlock, changes } = create({ recentBlocked: 2 });
		await flush();
		assert.strictEqual(service.blocked, 2);
		onDidBlock.fire({} as BlockedAttempt);
		assert.strictEqual(service.blocked, 3);
		assert.ok(changes() >= 2);
	});

	test('formatted() is formatLocalStatus of the status and the blocked count', async () => {
		const { service, onDidBlock } = create({ targets: async () => [target('127.0.0.1', 11434), target('192.168.1.20', 8000)] });
		await flush();
		onDidBlock.fire({} as BlockedAttempt);
		assert.deepStrictEqual(service.status, { kind: 'lan', hosts: ['192.168.1.20:8000'] });
		assert.deepStrictEqual(service.formatted(), formatLocalStatus(service.status, 1));
		assert.strictEqual(service.formatted().text, '$(circle-filled) LAN · 192.168.1.20:8000 · 1 blocked');
	});

	test('an unreadable guard state reads as unknown', async () => {
		const { service } = create({ targets: () => Promise.reject(new Error('no channel')) });
		await flush();
		assert.strictEqual(service.status, undefined);
		assert.strictEqual(service.formatted().text, '$(question) Status unknown');
	});

	test('refreshes on target and settings changes; a stale answer does not win', async () => {
		const answers: DeferredPromise<EgressTarget[]>[] = [];
		const { service, onDidChangeTargets, onDidChangeState, getTargetsCalls } = create({ targets: () => { const d = new DeferredPromise<EgressTarget[]>(); answers.push(d); return d.p; } });
		onDidChangeTargets.fire([]);
		onDidChangeState.fire();
		assert.strictEqual(getTargetsCalls(), 3);

		answers[2].complete([]);
		await flush();
		assert.deepStrictEqual(service.status, { kind: 'local', hosts: [] });
		answers[0].complete([target('example.com', 443)]); // older request answers last
		answers[1].complete([target('example.com', 443)]);
		await flush();
		assert.deepStrictEqual(service.status, { kind: 'local', hosts: [] });
	});
});
