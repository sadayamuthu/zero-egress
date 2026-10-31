/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Small pieces shared by the chat tabs and the history menu.

import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export const SmallIconButton = ({ Icon, label, onClick, className = '' }: { Icon: LucideIcon; label: string; onClick: () => void; className?: string }) => {
	return <button
		type='button'
		aria-label={label}
		data-tooltip-id='ze-tooltip'
		data-tooltip-place='bottom'
		data-tooltip-content={label}
		className={`size-[18px] p-[2px] flex items-center justify-center rounded text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover ${className}`}
		onMouseDown={e => e.stopPropagation()}
		onClick={e => { e.preventDefault(); e.stopPropagation(); onClick(); }}
		onDoubleClick={e => e.stopPropagation()}
	>
		<Icon size={13} />
	</button>;
};

/** an inline title editor: ⏎ or blur commits, Escape or an unchanged value cancels (`onDone(null)`) */
export const RenameInput = ({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) => {
	const [value, setValue] = useState(initial);
	const doneRef = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	const finish = (v: string | null) => {
		if (doneRef.current) {
			return;
		}
		doneRef.current = true;
		// committing the shown title unchanged must not pin it (an untitled chat keeps following its first message)
		onDone(v !== null && v.trim() === initial.trim() ? null : v);
	};
	return <input
		ref={inputRef}
		aria-label='Chat title'
		className='min-w-0 w-32 px-1 rounded text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-focusBorder)] outline-none'
		value={value}
		onChange={e => setValue(e.target.value)}
		onClick={e => e.stopPropagation()}
		onMouseDown={e => e.stopPropagation()}
		onDoubleClick={e => e.stopPropagation()}
		onKeyDown={e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(value);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(null);
			}
		}}
		onBlur={() => finish(value)}
	/>;
};
