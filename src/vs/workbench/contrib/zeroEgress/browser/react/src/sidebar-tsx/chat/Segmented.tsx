/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { onRadioGroupKeyDown } from './Popover.js';

export const Segmented = <T extends string>({ label, value, options, onChange }: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (v: T) => void;
}) => {
	// one row for the menu's ↑/↓ (Popover); ←/→ change the selection, as in a radio group. No radio is a Tab stop:
	// Tab leaves the menu
	return <div role='radiogroup' aria-label={label} className='flex rounded-[6px] border border-ze-border-2 overflow-hidden shrink-0'
		onKeyDown={e => onRadioGroupKeyDown(e, i => { if (options[i] && options[i].value !== value) { onChange(options[i].value); } })}
	>
		{options.map(o => <button
			key={o.value}
			type='button'
			role='radio'
			tabIndex={-1}
			aria-checked={o.value === value}
			className={`px-2 py-0.5 text-xs outline-none focus-visible:bg-[var(--vscode-list-hoverBackground)] ${o.value === value
				? 'bg-[var(--vscode-list-inactiveSelectionBackground)] text-ze-fg-1'
				: 'text-ze-fg-3 hover:text-ze-fg-1 hover:bg-[var(--vscode-list-hoverBackground)]'}`}
			onClick={e => { e.stopPropagation(); onChange(o.value); }}
		>{o.label}</button>)}
	</div>;
};
