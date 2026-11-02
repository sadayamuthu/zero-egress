/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools, InternalToolInfo } from '../prompt/prompts.js';
import { resolveRunMode } from '../customModes.js';
import { BAD_TOOL_STREAK_LIMIT, nextBadToolStreak, refusalOf, toolGroupOf, toolPolicyOfMode } from '../toolPolicy.js';

suite('toolPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const mcpTool: InternalToolInfo = { name: 'mcp_thing', description: 'd', params: {}, mcpServerName: 'x' };

	test('gather is read only', () => {
		const names = availableTools(toolPolicyOfMode('gather'), undefined)!.map(t => t.name);
		assert.ok(!names.includes('edit_file'));
		assert.ok(!names.includes('run_command'));
		assert.ok(!names.includes('update_plan'));
		assert.ok(names.includes('read_file'));
	});

	test('plan mode reads and plans only', () => {
		const names = availableTools(toolPolicyOfMode('plan'), [mcpTool])!.map(t => t.name);
		assert.ok(names.includes('read_file'));
		assert.ok(names.includes('update_plan'));
		assert.ok(!names.includes('edit_file'));
		assert.ok(!names.includes('run_command'));
		assert.ok(!names.includes('mcp_thing'));
	});

	test('agent gets update_plan', () => {
		assert.ok(availableTools(toolPolicyOfMode('agent'), undefined)!.some(t => t.name === 'update_plan'));
	});

	test('chat has no tools even with MCP', () => {
		assert.strictEqual(availableTools(null, [mcpTool]), undefined);
	});

	test('agent gets MCP', () => {
		assert.ok(availableTools(toolPolicyOfMode('agent'), [mcpTool])!.some(t => t.name === 'mcp_thing'));
	});

	test('groups', () => {
		assert.strictEqual(toolGroupOf('edit_file', false), 'edit');
		assert.strictEqual(toolGroupOf('run_command', false), 'terminal');
		assert.strictEqual(toolGroupOf('x', true), 'mcp');
		assert.strictEqual(toolGroupOf('read_file', false), 'read');
	});

	test('refusalOf gates by policy', () => {
		const copy = "This tool isn't available in this mode.";
		const gather = toolPolicyOfMode('gather');
		assert.strictEqual(refusalOf(gather, 'edit_file', false), copy);
		assert.strictEqual(refusalOf(gather, 'run_command', false), copy);
		assert.strictEqual(refusalOf(gather, 'mcp_thing', true), copy);
		assert.strictEqual(refusalOf(gather, 'read_file', false), null);
		assert.strictEqual(refusalOf(null, 'read_file', false), copy);
		const agent = toolPolicyOfMode('agent');
		for (const [n, mcp] of [['edit_file', false], ['run_command', false], ['mcp_thing', true], ['read_file', false]] as const) {
			assert.strictEqual(refusalOf(agent, n, mcp), null);
		}
	});

	test('resolveRunMode uses the built-in policy table', () => {
		for (const m of ['agent', 'gather', 'normal', 'plan'] as const) {
			assert.deepStrictEqual(resolveRunMode({ chatMode: m, customModes: [], activeCustomModeId: null }).toolPolicy, toolPolicyOfMode(m));
		}
	});

	test('bad tool streak: 3 refused or invalid calls in a row end the run', () => {
		assert.strictEqual(BAD_TOOL_STREAK_LIMIT, 3);
		let st = nextBadToolStreak(0, 'refused');
		assert.deepStrictEqual(st, { streak: 1, stopMessage: null });
		st = nextBadToolStreak(st.streak, 'ok');
		assert.deepStrictEqual(st, { streak: 0, stopMessage: null });
		st = nextBadToolStreak(st.streak, 'refused');
		st = nextBadToolStreak(st.streak, 'invalid');
		assert.strictEqual(st.stopMessage, null);
		st = nextBadToolStreak(st.streak, 'refused');
		assert.strictEqual(st.stopMessage, "Stopped: the model kept asking for tools this mode doesn't allow.");
		let iv = nextBadToolStreak(2, 'invalid');
		assert.strictEqual(iv.stopMessage, 'Stopped: the model kept sending invalid tool calls.');
		iv = nextBadToolStreak(0, 'invalid');
		assert.strictEqual(iv.stopMessage, null);
	});
});
