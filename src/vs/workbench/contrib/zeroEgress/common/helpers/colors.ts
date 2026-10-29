/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../../base/common/color.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';

// editCodeService colors
const sweepBG = new Color(new RGBA(100, 100, 100, .2));
const highlightBG = new Color(new RGBA(100, 100, 100, .1));
const sweepIdxBG = new Color(new RGBA(100, 100, 100, .5));

const acceptBG = new Color(new RGBA(155, 185, 85, .1)); // default is RGBA(155, 185, 85, .2)
const rejectBG = new Color(new RGBA(255, 0, 0, .1)); // default is RGBA(255, 0, 0, .2)

// Widget colors: theme variables, so every theme keeps them readable
export const acceptAllBg = 'var(--vscode-button-background)'
export const acceptBg = 'var(--vscode-button-background)'
export const acceptBorder = '1px solid var(--vscode-button-background)'

export const rejectAllBg = 'var(--vscode-button-secondaryBackground)'
export const rejectBg = 'var(--vscode-button-secondaryBackground)'
export const rejectBorder = '1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border))'

export const buttonFontSize = '11px'
export const buttonTextColor = 'var(--vscode-button-foreground)'
export const rejectTextColor = 'var(--vscode-button-secondaryForeground)'



const configOfBG = (color: Color) => {
	return { dark: color, light: color, hcDark: color, hcLight: color, }
}

// gets converted to --vscode-zeroEgress-greenBG, see zero-egress.css, asCssVariable
registerColor('zeroEgress.greenBG', configOfBG(acceptBG), '', true);
registerColor('zeroEgress.redBG', configOfBG(rejectBG), '', true);
registerColor('zeroEgress.sweepBG', configOfBG(sweepBG), '', true);
registerColor('zeroEgress.highlightBG', configOfBG(highlightBG), '', true);
registerColor('zeroEgress.sweepIdxBG', configOfBG(sweepIdxBG), '', true);
