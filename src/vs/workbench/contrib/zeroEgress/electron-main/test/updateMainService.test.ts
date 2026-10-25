/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ZeroEgressMainUpdateService } from '../zeroEgressUpdateMainService.js';

suite('UpdateMainService (no network)', () => {
	const productService = { zeroEgressVersion: '9.9.9' } as any;
	const service = new ZeroEgressMainUpdateService(productService);

	test('explicit check never fetches and returns manual-update message', async () => {
		let fetched = false;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => { fetched = true; throw new Error('no'); }) as typeof fetch;
		try {
			const res = await service.check(true);
			assert.strictEqual(fetched, false);
			assert.strictEqual(res!.message, 'ZeroEgress 9.9.9. Updates are manual: download new versions from github.com/sadayamuthu/zero-egress/releases.');
		} finally { globalThis.fetch = realFetch; }
	});

	test('implicit check returns null message', async () => {
		assert.strictEqual((await service.check(false))!.message, null);
	});
});
