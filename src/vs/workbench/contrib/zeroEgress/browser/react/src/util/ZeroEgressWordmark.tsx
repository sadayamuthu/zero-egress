/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useIsDark } from './services.js';

// The splash mark and wordmark are drawn inline (no raster, no card) so they sit
// directly on the editor background in every theme. Mark geometry is the bare
// mark from resources/zero-egress/logo.svg (crop box 12 22 72 64); keep in sync.
const ZE_MINT = '#34d399'
/** `markWidth` and `fontSize` in px; the defaults are the first-run splash size */
export const ZeroEgressWordmark = ({ markWidth = 128, fontSize = 56, gapClass = 'gap-5' }: { markWidth?: number, fontSize?: number, gapClass?: string }) => {
	// Faded arcs: .3 as in logo.svg on dark themes; a touch stronger on light
	// themes, where mint at .3 almost disappears into white.
	const arcOpacity = useIsDark() ? '.3' : '.5'
	return (
		<div className={`flex flex-col items-center ${gapClass} select-none`} role='img' aria-label='ZeroEgress'>
			<svg viewBox='12 22 72 64' width={markWidth} height={Math.round(markWidth * 64 / 72)} aria-hidden='true'>
				<path d='M16 40 a44 44 0 0 1 64 0' fill='none' stroke={ZE_MINT} strokeWidth='7' strokeLinecap='round' opacity={arcOpacity} />
				<path d='M28 51 a28 28 0 0 1 40 0' fill='none' stroke={ZE_MINT} strokeWidth='7' strokeLinecap='round' opacity={arcOpacity} />
				<ellipse cx='48' cy='70' rx='9' ry='12' fill='none' stroke={ZE_MINT} strokeWidth='5.5' />
				<line x1='43' y1='78' x2='53' y2='62' stroke={ZE_MINT} strokeWidth='5' strokeLinecap='round' />
			</svg>
			<div
				style={{
					color: 'var(--vscode-foreground)',
					fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
					fontSize: `${fontSize}px`,
					lineHeight: 1,
					letterSpacing: '-0.5px',
				}}
			>
				<span style={{ fontWeight: 700 }}>Zero</span><span style={{ fontWeight: 400 }}>Egress</span>
			</div>
		</div>
	)
}
