/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkTerminalOwner, terminalIdsVisibleTo } from '../terminalOwnership.js';

suite('terminalOwnership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// '1' is the user's, '2' belongs to agent ab12cd34, '3' to agent ef56ab78
	const owners: Record<string, string | undefined> = { '2': 'ab12cd34', '3': 'ef56ab78' };
	const ownerOf = (id: string) => owners[id];
	const ids = ['1', '2', '3'];

	test('docked sees only terminals no agent owns', () => {
		assert.deepStrictEqual(terminalIdsVisibleTo(ids, ownerOf, undefined), ['1']);
	});

	test('an agent sees only its own terminals', () => {
		assert.deepStrictEqual(terminalIdsVisibleTo(ids, ownerOf, 'ab12cd34'), ['2']);
	});

	test('an agent may use its own terminal', () => {
		assert.doesNotThrow(() => checkTerminalOwner('2', ownerOf, 'ab12cd34'));
	});

	test('an agent may not use the user\'s or another agent\'s terminal', () => {
		assert.throws(() => checkTerminalOwner('1', ownerOf, 'ab12cd34'), (e: Error) => e.message === 'Terminal 1 does not belong to this agent.');
		assert.throws(() => checkTerminalOwner('3', ownerOf, 'ab12cd34'), (e: Error) => e.message === 'Terminal 3 does not belong to this agent.');
	});

	test('docked may not use an agent\'s terminal', () => {
		assert.doesNotThrow(() => checkTerminalOwner('1', ownerOf, undefined));
		assert.throws(() => checkTerminalOwner('2', ownerOf, undefined), /Terminal 2 does not belong to this agent\./);
	});
});
