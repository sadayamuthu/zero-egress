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
	ensureNoDisposablesAreLeakedInTestSuite();

	function mainThread(getTargets: () => Promise<EgressTargetDto[]>) {
		const reported: string[] = [];
		const shape: MainThreadEgressGuardShape = { $getTargets: getTargets, $reportBlocked: url => { reported.push(url); }, dispose() { } };
		return { shape, reported };
	}

	test('before init only loopback passes; init loads the allow-list', async () => {
		const { shape, reported } = mainThread(async () => [{ host: 'gpubox', port: 8000 }]);
		const guard = new ExtHostEgressGuard(shape, new NullLogService());
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
		const guard = new ExtHostEgressGuard(shape, new NullLogService());
		const init = guard.init();
		await guard.$setTargets([{ host: 'new.corp.internal', port: 443 }]);
		reply.complete([{ host: 'old.corp.internal', port: 443 }]);
		await init;
		assert.strictEqual(guard.check('https://new.corp.internal/'), true);
		assert.strictEqual(guard.check('https://old.corp.internal/'), false);
	});

	test('a failed init leaves loopback only', async () => {
		const { shape } = mainThread(async () => { throw new Error('no main thread'); });
		const guard = new ExtHostEgressGuard(shape, new NullLogService());
		await guard.init();
		assert.strictEqual(guard.check('http://localhost:1234/'), true);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false);
	});

	test('$setTargets replaces the list', async () => {
		const { shape } = mainThread(async () => [{ host: '10.0.0.5', port: 8000 }]);
		const guard = new ExtHostEgressGuard(shape, new NullLogService());
		await guard.init();
		await guard.$setTargets([{ host: '10.0.0.7', port: 8000 }]);
		assert.strictEqual(guard.check('http://10.0.0.5:8000/'), false);
		assert.strictEqual(guard.check('http://10.0.0.7:8000/'), true);
	});
});
