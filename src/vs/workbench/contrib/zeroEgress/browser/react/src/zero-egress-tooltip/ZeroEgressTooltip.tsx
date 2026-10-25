/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import '../styles.css'
import { Tooltip } from 'react-tooltip';
import 'react-tooltip/dist/react-tooltip.css';
import { useIsDark } from '../util/services.js';

/**
 * Creates a configured global tooltip component with consistent styling
 * To use:
 * 1. Mount a Tooltip with some id eg id='ze-tooltip'
 * 2. Add data-tooltip-id="ze-tooltip" and data-tooltip-content="Your tooltip text" to any element
 */
export const ZeroEgressTooltip = () => {


	const isDark = useIsDark()

	return (

		// use native colors so we don't have to worry about @@ze-scope styles
		// --ze-bg-1: var(--vscode-input-background);
		// --ze-bg-1-alt: var(--vscode-badge-background);
		// --ze-bg-2: var(--vscode-sideBar-background);
		// --ze-bg-2-alt: color-mix(in srgb, var(--vscode-sideBar-background) 30%, var(--vscode-editor-background) 70%);
		// --ze-bg-3: var(--vscode-editor-background);

		// --ze-fg-0: color-mix(in srgb, var(--vscode-tab-activeForeground) 90%, black 10%);
		// --ze-fg-1: var(--vscode-editor-foreground);
		// --ze-fg-2: var(--vscode-input-foreground);
		// --ze-fg-3: var(--vscode-input-placeholderForeground);
		// /* --ze-fg-4: var(--vscode-tab-inactiveForeground); */
		// --ze-fg-4: var(--vscode-list-deemphasizedForeground);

		// --ze-warning: var(--vscode-charts-yellow);

		// --ze-border-1: var(--vscode-commandCenter-activeBorder);
		// --ze-border-2: var(--vscode-commandCenter-border);
		// --ze-border-3: var(--vscode-commandCenter-inactiveBorder);
		// --ze-border-4: var(--vscode-editorGroup-border);

		<>
			<style>
				{`
				#ze-tooltip, #ze-tooltip-orange, #ze-tooltip-green, #ze-tooltip-ollama-settings, #ze-tooltip-provider-info {
					font-size: 12px;
					padding: 0px 8px;
					border-radius: 6px;
					z-index: 999999;
					max-width: 300px;
					word-wrap: break-word;
				}

				#ze-tooltip {
					background-color: var(--vscode-editor-background);
					color: var(--vscode-input-foreground);
				}

				#ze-tooltip-orange {
					background-color: #F6762A;
					color: white;
				}

				#ze-tooltip-green {
					background-color: #228B22;
					color: white;
				}

				#ze-tooltip-ollama-settings, #ze-tooltip-provider-info {
					background-color: var(--vscode-editor-background);
					color: var(--vscode-input-foreground);
				}

				.react-tooltip-arrow {
					z-index: -1 !important; /* Keep arrow behind content (somehow this isnt done automatically) */
				}
				`}
			</style>


			<Tooltip
				id="ze-tooltip"
				// border='1px solid var(--vscode-editorGroup-border)'
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				delayShow={50}
			/>
			<Tooltip
				id="ze-tooltip-orange"
				border='1px solid rgba(200,200,200,.3)'
				opacity={1}
				delayShow={50}
			/>
			<Tooltip
				id="ze-tooltip-green"
				border='1px solid rgba(200,200,200,.3)'
				opacity={1}
				delayShow={50}
			/>
			<Tooltip
				id="ze-tooltip-ollama-settings"
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				openEvents={{ mouseover: true, click: true, focus: true }}
				place='right'
				style={{ pointerEvents: 'all', userSelect: 'text', fontSize: 11 }}
			>
				<div style={{ padding: '8px 10px' }}>
					<div style={{ opacity: 0.8, textAlign: 'center', fontWeight: 'bold', marginBottom: 8 }}>
						Good starter models
					</div>
					<div style={{ marginBottom: 4 }}>
						<span style={{ opacity: 0.8 }}>For chat:{` `}</span>
						<span style={{ opacity: 0.8, fontWeight: 'bold' }}>gemma3</span>
					</div>
					<div style={{ marginBottom: 4 }}>
						<span style={{ opacity: 0.8 }}>For autocomplete:{` `}</span>
						<span style={{ opacity: 0.8, fontWeight: 'bold' }}>qwen2.5-coder</span>
					</div>
					<div style={{ marginBottom: 0 }}>
						<span style={{ opacity: 0.8 }}>Use the largest version of these you can!</span>
					</div>
				</div>
			</Tooltip>

			<Tooltip
				id="ze-tooltip-provider-info"
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				delayShow={50}
				style={{ pointerEvents: 'all', userSelect: 'text', fontSize: 11, maxWidth: '280px', paddingTop:'8px', paddingBottom:'8px' }}
			/>
		</>
	);
};
