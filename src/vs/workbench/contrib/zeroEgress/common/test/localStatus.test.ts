/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { targetFromUrl } from '../egressPolicy.js';
import { formatLocalStatus, LocalStatus, localStatusOf, targetLabel } from '../localStatus.js';

const T = (u: string) => targetFromUrl(u)!;

suite('localStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('all loopback is local', () => {
		assert.deepStrictEqual(localStatusOf([T('http://localhost:11434'), T('http://127.0.0.1:1234')]), { kind: 'local', hosts: [] });
		assert.deepStrictEqual(localStatusOf([]), { kind: 'local', hosts: [] });
	});

	test('private is lan', () => {
		assert.deepStrictEqual(localStatusOf([T('http://localhost:11434'), T('http://gpubox:8000')]), { kind: 'lan', hosts: ['gpubox:8000'] });
	});

	test('public beats lan', () => {
		assert.deepStrictEqual(localStatusOf([T('http://gpubox:8000'), T('https://h.example')]), { kind: 'internet', hosts: ['h.example:443'] });
	});

	test('ipv6 label', () => {
		assert.strictEqual(targetLabel(T('http://[fd00::1]:8000')), '[fd00::1]:8000');
	});

	test('a configured LAN provider counts even when no feature selects it', () => {
		// model lists are polled from every provider's endpoint, used or not (refreshModelService),
		// so every target the guard allows counts
		const all = [T('http://localhost:11434'), T('http://10.0.0.5:8000')];
		assert.deepStrictEqual(localStatusOf(all), { kind: 'lan', hosts: ['10.0.0.5:8000'] });
	});

	test('format', () => {
		assert.strictEqual(formatLocalStatus({ kind: 'local', hosts: [] }, 0).text, '$(circle-filled) Local');
		assert.strictEqual(formatLocalStatus({ kind: 'local', hosts: [] }, 3).text, '$(circle-filled) Local · 3 blocked');
		assert.strictEqual(formatLocalStatus({ kind: 'lan', hosts: ['gpubox:8000'] }, 0).text, '$(circle-filled) LAN · gpubox:8000');
		assert.strictEqual(formatLocalStatus({ kind: 'lan', hosts: ['a:1', 'b:2'] }, 0).text, '$(circle-filled) LAN · 2 hosts');
		assert.strictEqual(formatLocalStatus({ kind: 'internet', hosts: ['h.example:443'] }, 0).text, '$(warning) Internet · h.example:443');
		assert.ok(formatLocalStatus({ kind: 'lan', hosts: ['a:1', 'b:2'] }, 0).tooltip.includes('a:1'));
		for (const s of [{ kind: 'local', hosts: [] }, { kind: 'internet', hosts: ['h:1'] }] as LocalStatus[]) {
			const f = formatLocalStatus(s, 0);
			assert.ok(!/byte/i.test(f.text + f.tooltip));
		}
	});

	test('format unknown', () => {
		assert.strictEqual(formatLocalStatus(undefined, 0).text, '$(question) Status unknown');
	});
});
