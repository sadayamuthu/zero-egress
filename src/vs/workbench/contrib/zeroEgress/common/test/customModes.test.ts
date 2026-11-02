/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CustomMode, resolveRunMode, runModeFor, selectBuiltInMode, validateCustomMode } from '../customModes.js';

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

	test('selectBuiltInMode leaves the custom mode so the built-in pick takes effect', async () => {
		const gs: { chatMode: 'agent' | 'plan' | 'gather' | 'normal'; customModes: CustomMode[]; activeCustomModeId: string | null } = { chatMode: 'agent', customModes: [mode({ tools: { edit: true } })], activeCustomModeId: 'm1' };
		const settings = { setGlobalSetting: (k: 'chatMode' | 'activeCustomModeId', v: any) => { (gs as any)[k] = v; return Promise.resolve(); } };
		await selectBuiltInMode(settings, 'plan');
		assert.strictEqual(resolveRunMode(gs).chatMode, 'plan');
		assert.strictEqual(gs.activeCustomModeId, null);
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

	test('malformed other modes never make validation throw', () => {
		const bad = [{ id: 'x' }, { id: 'y', name: 5 }] as unknown as CustomMode[]
		assert.strictEqual(validateCustomMode(mode({ name: 'Ok' }), bad), null);
		assert.strictEqual(validateCustomMode(mode({ name: '' }), bad), 'Give the mode a name.');
	});

	test('non-boolean tool values never grant access', () => {
		const m = { ...mode({}), tools: { edit: 'false', terminal: 1, mcp: 'true' } } as unknown as CustomMode;
		const r = resolveRunMode({ chatMode: 'agent', customModes: [m], activeCustomModeId: 'm1' });
		assert.strictEqual(r.chatMode, 'gather');
		assert.deepStrictEqual(r.toolPolicy, { edit: false, terminal: false, mcp: false, plan: false });
	});

	test('corrupted customModes falls back', () => {
		const r = resolveRunMode({ chatMode: 'plan', customModes: {} as unknown as CustomMode[], activeCustomModeId: 'm1' });
		assert.strictEqual(r.chatMode, 'plan');
		assert.strictEqual(r.customModeId, undefined);
	});

	test('caps are enforced at use time', () => {
		const long = mode({ name: '  ' + 'x”\ny'.repeat(20) + '  ', instructions: 'a'.repeat(5000) });
		const r = resolveRunMode({ chatMode: 'agent', customModes: [long], activeCustomModeId: 'm1' });
		const [header, body] = r.extraInstructions!.split('):\n');
		assert.strictEqual(body.length, 4000);
		assert.ok(r.label.length <= 24);
		assert.ok(!/[\n”]/.test(header.slice('MODE INSTRUCTIONS (custom mode “'.length, -1)));
	});

	test('run precedence', () => {
		const gs = { chatMode: 'agent' as const, customModes: [mode({ instructions: 'hi' })], activeCustomModeId: 'm1' };
		const custom = runModeFor({ isBackground: false, gs });
		assert.strictEqual(custom.customModeId, 'm1');
		const bg = runModeFor({ isBackground: true, gs });
		assert.strictEqual(bg.chatMode, 'agent');
		assert.strictEqual(bg.label, 'Agent');
		assert.strictEqual(bg.extraInstructions, undefined);
		assert.strictEqual(bg.customModeId, undefined);
		const ov = runModeFor({ modeOverride: 'gather', isBackground: true, gs });
		assert.strictEqual(ov.label, 'Gather');
		assert.deepStrictEqual(ov.toolPolicy, { edit: false, terminal: false, mcp: false, plan: false });
		assert.strictEqual(ov.extraInstructions, undefined);
		assert.strictEqual(runModeFor({ modeOverride: 'normal', isBackground: false, gs }).label, 'Chat');
	});
});
