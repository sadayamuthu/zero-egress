/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools, InternalToolInfo } from '../prompt/prompts.js';
import { toolGroupOf, toolPolicyOfMode } from '../toolPolicy.js';

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
});
