/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MetricsMainService } from '../metricsMainService.js';

suite('MetricsMainService (no-op)', () => {
	test('capture and setOptOut make no network call', async () => {
		let fetched = false;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => { fetched = true; throw new Error('no'); }) as typeof fetch;
		try {
			const service = new MetricsMainService();
			service.capture('x', {});
			service.setOptOut(true);
			await service.getDebuggingProperties();
			await new Promise(r => setTimeout(r, 50));
			assert.strictEqual(fetched, false);
		} finally { globalThis.fetch = realFetch; }
	});
});
