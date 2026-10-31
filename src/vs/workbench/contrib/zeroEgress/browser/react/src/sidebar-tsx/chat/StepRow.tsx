/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// One step of an agent run (a tool call, a reasoning block) as a single muted line: an icon, a label with the file
// names in the primary text color (StepName), an optional detail (e.g. LineCounts) and trailing controls. Clicking the
// line toggles `children`; `bottom` is shown under the line either way.

import React, { useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Ellipsis, Pencil, SquareTerminal } from 'lucide-react';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks

export type StepIcon = 'ok' | 'edit' | 'think' | 'run' | 'error';

const iconOf: Record<StepIcon, React.ReactNode> = {
	ok: <Check size={13} className='text-ze-ok' />,
	edit: <Pencil size={12} className='text-ze-fg-3' />,
	think: <Ellipsis size={13} className='text-ze-fg-3' />,
	run: <SquareTerminal size={13} className='text-ze-fg-3' />,
	error: <AlertTriangle size={13} className='text-ze-warning' />,
};

/** a file (or other name) inside a step's label, in the primary text color */
export const StepName = ({ children, onClick, tooltip }: { children: React.ReactNode; onClick?: () => void; tooltip?: string }) => {
	return <span
		className={`text-ze-fg-1 font-medium truncate ${onClick ? 'cursor-pointer hover:underline' : ''}`}
		onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
		{...tooltip ? {
			'data-tooltip-id': 'ze-tooltip',
			'data-tooltip-content': tooltip,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{children}</span>;
};

/** `+a −r` in the added/removed colors; a zero side is left out */
export const LineCounts = ({ added, removed }: { added: number; removed: number }) => {
	if (added === 0 && removed === 0) {
		return null;
	}
	return <span className='flex items-center gap-1 shrink-0 tabular-nums'>
		{added > 0 && <span className='text-[var(--vscode-gitDecoration-addedResourceForeground)]'>+{added}</span>}
		{removed > 0 && <span className='text-[var(--vscode-gitDecoration-deletedResourceForeground)]'>−{removed}</span>}
	</span>;
};

export const StepRow = ({ icon, label, detail, children, open, onToggle, onClick, right, bottom, rejected, className }: {
	icon: StepIcon;
	label: React.ReactNode;
	detail?: React.ReactNode;
	/** shown when the row is expanded; `null` still makes the row expandable (an empty body) */
	children?: React.ReactNode;
	/** controlled open state; leave out to let the row keep its own */
	open?: boolean;
	onToggle?: () => void;
	/** runs on a click of the line, besides toggling */
	onClick?: () => void;
	/** trailing controls; clicks on them don't toggle the row */
	right?: React.ReactNode;
	bottom?: React.ReactNode;
	/** a canceled step: the label is struck through */
	rejected?: boolean;
	className?: string;
}) => {
	const [openState, setOpenState] = useState(false);
	const isExpandable = children !== undefined;
	const isOpen = open ?? openState;
	const isClickable = isExpandable || !!onClick;

	const onLineClick = () => {
		if (isExpandable) {
			if (onToggle) { onToggle(); } else { setOpenState(v => !v); }
		}
		onClick?.();
	};

	return <div className={className}>
		<div
			className={`select-none flex items-center gap-2 min-h-[20px] text-sm text-ze-fg-3 ${isClickable ? 'cursor-pointer hover:text-ze-fg-2' : ''}`}
			onClick={isClickable ? onLineClick : undefined}
			role={isExpandable ? 'button' : undefined}
			aria-expanded={isExpandable ? isOpen : undefined}
		>
			<span className='w-3.5 flex items-center justify-center shrink-0'>{iconOf[icon]}</span>
			<span className={`flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap ${rejected ? 'line-through' : ''}`}>{label}</span>
			{detail !== undefined && detail !== null && detail !== '' && <span className='flex items-center gap-1 text-xs min-w-0 truncate'>{detail}</span>}
			<span className='flex-1' />
			{right && <span className='flex items-center gap-x-2 shrink-0 text-xs' onClick={e => e.stopPropagation()}>{right}</span>}
			{isExpandable && <ChevronRight size={14} className={`shrink-0 text-ze-fg-3 transition-transform duration-100 ${isOpen ? 'rotate-90' : ''}`} />}
		</div>
		{isExpandable && isOpen && <div className='mt-1 ml-[22px] text-ze-fg-4 rounded-sm overflow-x-auto'>
			{children}
		</div>}
		{bottom}
	</div>;
};
