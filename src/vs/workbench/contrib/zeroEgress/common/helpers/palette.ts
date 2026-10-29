/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The ZeroEgress Dark palette. extensions/theme-defaults/themes/zero_egress_dark.json uses these values;
// node/test/zeroEgressTheme.test.ts keeps the two in sync.
export const ZE_PALETTE = {
	bg: '#0e0f12',
	panel: '#15171c',
	panel2: '#1b1e24',
	line: '#262a33',
	text: '#d7dae0',
	muted: '#7d8590',
	accent: '#7aa2ff',
	onAccent: '#0b1020',
	addedBg: '#1f3b2a',
	addedFg: '#7ee2a8',
	removedBg: '#3d1f24',
	removedFg: '#ff8f9a',
	ok: '#4ade80',
} as const;

function relativeLuminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two `#rrggbb` colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
