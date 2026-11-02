/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CustomMode, resolveRunMode, validateCustomMode } from '../customModes.js';

const mode = (o: { name?: string; instructions?: string; tools?: Partial<CustomMode['tools']> }): CustomMode => ({
	id: 'm1', name: o.name ?? 'Mine', icon: 'eye', instructions: o.instructions ?? '',
	tools: { edit: false, terminal: false, mcp: false, ...o.tools },
});

suite('customModes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('read-only custom mode', () => {
		const r = resolveRunMode({ chatMode: 'agent', customModes: [mode({})], activeCustomModeId: 'm1' });
		assert.strictEqual(r.chatMode, 'gather');
		assert.deepStrictEqual(r.toolPolicy, { edit: false, terminal: false, mcp: false, plan: false });
		assert.strictEqual(r.customModeId, 'm1');
	});

	test('editing custom mode', () => {
		const r = resolveRunMode({ chatMode: 'gather', customModes: [mode({ tools: { edit: true }, instructions: 'Be terse.' })], activeCustomModeId: 'm1' });
		assert.strictEqual(r.chatMode, 'agent');
		assert.strictEqual(r.toolPolicy?.plan, true);
		assert.strictEqual(r.extraInstructions, 'MODE INSTRUCTIONS (custom mode “Mine”):\nBe terse.');
	});

	test('missing id falls back', () => {
		const r = resolveRunMode({ chatMode: 'gather', customModes: [], activeCustomModeId: 'gone' });
		assert.strictEqual(r.chatMode, 'gather');
		assert.strictEqual(r.customModeId, undefined);
	});

	test('names', () => {
		assert.strictEqual(validateCustomMode(mode({ name: '' }), []), 'Give the mode a name.');
		assert.strictEqual(validateCustomMode(mode({ name: 'agent' }), []), 'Another mode already has this name.');
		assert.strictEqual(validateCustomMode(mode({ name: 'Ok' }), []), null);
	});
});
