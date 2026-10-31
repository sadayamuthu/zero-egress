/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EgressProofChannel } from '../egressProofChannel.js';

suite('EgressProofChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const calls: unknown[][] = [];
		const service = {
			getSummary: async () => { calls.push(['getSummary']); return 'summary' as any; },
			createReport: async (...a: unknown[]) => { calls.push(['createReport', ...a]); return undefined; },
			verifyReport: async (...a: unknown[]) => { calls.push(['verifyReport', ...a]); return { checks: [] }; },
			pickReportFiles: async () => { calls.push(['pickReportFiles']); return undefined; },
			key: () => { calls.push(['key']); return 'secret'; },
			identity: () => { calls.push(['identity']); return {}; },
		};
		return { calls, channel: new EgressProofChannel(service) };
	}

	test('serves only the interface methods', async () => {
		const { calls, channel } = setup();
		assert.strictEqual(await channel.call('', 'getSummary'), 'summary');
		await channel.call('', 'createReport', [{ days: 7 }, true]);
		await channel.call('', 'verifyReport', ['/r.json', '/r.pdf']);
		await channel.call('', 'pickReportFiles', []);
		for (const other of ['key', 'identity', 'keyInfo', 'modelUsage', 'thisMachine', 'constructor', 'toString']) {
			await assert.rejects(channel.call('', other, []), /Call not found/);
		}
		assert.deepStrictEqual(calls, [['getSummary'], ['createReport', { days: 7 }, true], ['verifyReport', '/r.json', '/r.pdf'], ['pickReportFiles']]);
	});

	test('checks argument types', async () => {
		const { calls, channel } = setup();
		await assert.rejects(channel.call('', 'verifyReport', [42]));
		await assert.rejects(channel.call('', 'createReport', ['7']));
		await channel.call('', 'createReport', [{ from: 'a', to: 'b', extra: 1 }, 'yes']);
		await channel.call('', 'verifyReport', ['/r.json', 5]);
		assert.deepStrictEqual(calls, [['createReport', { from: 'a', to: 'b' }, false], ['verifyReport', '/r.json', undefined]]);
		assert.throws(() => channel.listen('', 'onAnything'));
	});
});
