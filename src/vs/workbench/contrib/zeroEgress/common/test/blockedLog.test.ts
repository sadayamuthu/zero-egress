/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BlockedLogCoalescer, formatBlockedAttempt } from '../blockedLog.js';
import { BlockedAttempt } from '../egressGuardService.js';

suite('BlockedLogCoalescer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const at = (url: string, time: number, origin: BlockedAttempt['origin'] = 'extensionHost'): BlockedAttempt => ({ url, time, origin });

	test('one line per attempt, never the path or query', () => {
		assert.strictEqual(formatBlockedAttempt(at('https://api.example.com/secret?q=1', 0, 'renderer')), '1970-01-01T00:00:00.000Z blocked api.example.com:443 (caller: renderer)\n');
	});

	test('a retry loop writes one line, then one summary when the window ends', () => {
		const c = new BlockedLogCoalescer(60_000);
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) { lines.push(...c.add(at('https://telemetry.example.com/v1?n=' + i, i * 100))); }
		assert.deepStrictEqual(lines, ['1970-01-01T00:00:00.000Z blocked telemetry.example.com:443 (caller: extensionHost)\n']);
		assert.deepStrictEqual(c.flush(59_999), []);
		assert.deepStrictEqual(c.flush(60_000), ['1970-01-01T00:01:00.000Z blocked telemetry.example.com:443 (caller: extensionHost) 499 more times in the 60 s after the line above for it\n']);
		assert.deepStrictEqual(c.flush(120_000), [], 'the window is closed');
		assert.strictEqual(c.add(at('https://telemetry.example.com/', 130_000)).length, 1, 'a later attempt opens a new window');
	});

	test('different destinations and callers are kept apart; a single attempt has no summary', () => {
		const c = new BlockedLogCoalescer(1000);
		assert.strictEqual(c.add(at('http://10.0.0.1:80/', 0)).length, 1);
		assert.strictEqual(c.add(at('http://10.0.0.2:80/', 1)).length, 1);
		assert.strictEqual(c.add(at('http://10.0.0.1:80/', 2, 'renderer')).length, 1);
		assert.strictEqual(c.add(at('http://10.0.0.1:80/x', 3)).length, 0);
		const later = c.add(at('http://10.0.0.3:80/', 5000));
		assert.deepStrictEqual(later.map(l => l.replace(/^\S+ /, '')), [
			'blocked 10.0.0.1:80 (caller: extensionHost) 1 more time in the 1 s after the line above for it\n',
			'blocked 10.0.0.3:80 (caller: extensionHost)\n',
		]);
	});
});
