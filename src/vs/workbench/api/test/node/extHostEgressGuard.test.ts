/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { EgressTargetDto, MainThreadEgressGuardShape } from '../../common/extHost.protocol.js';
import { ExtHostEgressGuard } from '../../node/extHostEgressGuard.js';

suite('ExtHostEgressGuard', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mainThread(getTargets: () => Promise<EgressTargetDto[]>) {
		const reported: string[] = [];
		const allowed: { url: string; count: number }[][] = [];
		const shape: MainThreadEgressGuardShape = { $getTargets: getTargets, $reportBlocked: url => { reported.push(url); }, $reportAllowed: counts => { allowed.push(counts); }, dispose() { } };
		return { shape, reported, allowed };
	}

	test('before init only loopback passes; init loads the allow-list', async () => {
		const { shape, reported } = mainThread(async () => [{ host: 'gpubox', port: 8000 }]);
		const guard = store.add(new ExtHostEgressGuard(shape, new NullLogService()));
		assert.strictEqual(guard.check('http://127.0.0.1:11434/'), true);
		assert.strictEqual(guard.check('http://gpubox:8000/'), false);
		await guard.init();
		assert.strictEqual(guard.check('http://gpubox:8000/'), true);
		assert.strictEqual(guard.check('https://example.com/'), false);
		assert.deepStrictEqual(reported, ['http://gpubox:8000/', 'https://example.com/']);
	});

	test('a push that races the initial reply wins', async () => {
		const reply = new DeferredPromise<EgressTargetDto[]>();
		const { shape } = mainThread(() => reply.p);
		const guard = store.add(new ExtHostEgressGuard(shape, new NullLogService()));
		const init = guard.init();
		await guard.$setTargets([{ host: 'new.corp.internal', port: 443 }]);
		reply.complete([{ host: 'old.corp.internal', port: 443 }]);
		await init;
		assert.strictEqual(guard.check('https://new.corp.internal/'), true);
		assert.strictEqual(guard.check('https://old.corp.internal/'), false);
	});

	test('a failed init leaves loopback only', async () => {
		const { shape } = mainThread(async () => { throw new Error('no main thread'); });
		const guard = store.add(new ExtHostEgressGuard(shape, new NullLogService()));
		await guard.init();
		assert.strictEqual(guard.check('http://localhost:1234/'), true);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false);
	});

	test('$setTargets replaces the list', async () => {
		const { shape } = mainThread(async () => [{ host: '10.0.0.5', port: 8000 }]);
		const guard = store.add(new ExtHostEgressGuard(shape, new NullLogService()));
		await guard.init();
		await guard.$setTargets([{ host: '10.0.0.7', port: 8000 }]);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false);
		assert.strictEqual(guard.check('http://10.0.0.7:8000/'), true);
	});

	test('allowed socket checks are counted per URL and reported in batches', async () => {
		const { shape, allowed, reported } = mainThread(async () => [{ host: 'gpubox', port: 8000, reason: 'model server (set in Settings)' }]);
		const guard = store.add(new ExtHostEgressGuard(shape, new NullLogService()));
		await guard.init();
		assert.strictEqual(guard.check('http://gpubox:8000/', 'socket'), true);
		assert.strictEqual(guard.check('http://gpubox:8000/', 'socket'), true);
		assert.strictEqual(guard.check('http://gpubox:8000/v1', 'wrapper'), true);
		assert.strictEqual(guard.check('dns://gpubox/', 'lookup'), true);
		assert.strictEqual(guard.check('http://127.0.0.1:1/x', 'electronNet'), true);
		assert.strictEqual(guard.check('http://example.com:80/', 'socket'), false);
		assert.deepStrictEqual(allowed, [], 'nothing is sent before the interval');
		guard.flushAllowed();
		guard.flushAllowed();
		assert.deepStrictEqual(allowed, [[{ url: 'http://gpubox:8000/', count: 2 }, { url: 'http://127.0.0.1:1/', count: 1 }]], 'host:port only, never the path');
		assert.deepStrictEqual(reported, ['http://example.com:80/']);
	});
});
