/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolveAuditConfig, AUDIT_DEFAULTS } from '../auditConfig.js';

suite('resolveAuditConfig', () => {
	test('returns defaults when no sources given', () => {
		assert.deepStrictEqual(resolveAuditConfig({}), AUDIT_DEFAULTS);
	});

	test('product values override defaults', () => {
		const c = resolveAuditConfig({ product: { enabled: true, endpointUrl: 'https://c/ingest', batchSize: 10 } });
		assert.strictEqual(c.enabled, true);
		assert.strictEqual(c.endpointUrl, 'https://c/ingest');
		assert.strictEqual(c.batchSize, 10);
		assert.strictEqual(c.flushIntervalMs, AUDIT_DEFAULTS.flushIntervalMs);
	});

	test('policy overrides product (enterprise wins)', () => {
		const c = resolveAuditConfig({ product: { enabled: true }, policy: { enabled: false } });
		assert.strictEqual(c.enabled, false);
	});

	test('ignores wrong-typed and undefined fields', () => {
		const c = resolveAuditConfig({ product: { enabled: 'yes' as unknown as boolean, batchSize: undefined } });
		assert.strictEqual(c.enabled, false);
		assert.strictEqual(c.batchSize, AUDIT_DEFAULTS.batchSize);
	});
});
