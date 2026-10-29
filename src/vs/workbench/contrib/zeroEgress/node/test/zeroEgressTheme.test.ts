/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { COLOR_THEME_DARK_INITIAL_COLORS, ThemeSettingDefaults } from '../../../../services/themes/common/workbenchThemeService.js';
import { contrastRatio, ZE_PALETTE } from '../../common/helpers/palette.js';

// Reads the theme files from the repo root (test-node runs from there).
suite('ZeroEgress Dark theme', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const readJson = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));

	test('is registered and default', () => {
		const pkg = readJson('extensions/theme-defaults/package.json');
		const entry = pkg.contributes.themes.find((t: { id: string }) => t.id === 'ZeroEgress Dark');
		assert.ok(entry);
		assert.strictEqual(entry.uiTheme, 'vs-dark');
		assert.strictEqual(entry.path, './themes/zero_egress_dark.json');
		assert.strictEqual(ThemeSettingDefaults.COLOR_THEME_DARK, 'ZeroEgress Dark');
	});

	test('uses the palette', () => {
		const c = readJson('extensions/theme-defaults/themes/zero_egress_dark.json').colors;
		assert.strictEqual(c['editor.background'], ZE_PALETTE.bg);
		assert.strictEqual(c['sideBar.background'], ZE_PALETTE.panel);
		assert.strictEqual(c['titleBar.activeBackground'], ZE_PALETTE.panel);
		assert.strictEqual(c['statusBar.background'], ZE_PALETTE.panel);
		assert.strictEqual(c['focusBorder'], ZE_PALETTE.accent);
		assert.strictEqual(c['button.background'], ZE_PALETTE.accent);
		assert.strictEqual(c['button.foreground'], ZE_PALETTE.onAccent);
		assert.strictEqual(c['activityBar.activeBorder'], ZE_PALETTE.accent);
		assert.strictEqual(c['zeroEgress.greenBG'], ZE_PALETTE.addedBg);
		assert.strictEqual(c['zeroEgress.redBG'], ZE_PALETTE.removedBg);
	});

	test('first-paint colors match the theme', () => {
		const c = readJson('extensions/theme-defaults/themes/zero_egress_dark.json').colors;
		for (const k of ['editor.background', 'sideBar.background', 'titleBar.activeBackground', 'statusBar.background', 'activityBar.background']) {
			assert.strictEqual((COLOR_THEME_DARK_INITIAL_COLORS as Record<string, string>)[k], c[k], k);
		}
	});

	test('text is readable', () => {
		assert.ok(contrastRatio(ZE_PALETTE.text, ZE_PALETTE.bg) >= 7);
		assert.ok(contrastRatio(ZE_PALETTE.muted, ZE_PALETTE.bg) >= 4.5);
		assert.ok(contrastRatio(ZE_PALETTE.muted, ZE_PALETTE.panel) >= 4.5);
		assert.ok(contrastRatio(ZE_PALETTE.onAccent, ZE_PALETTE.accent) >= 4.5);
	});
});
