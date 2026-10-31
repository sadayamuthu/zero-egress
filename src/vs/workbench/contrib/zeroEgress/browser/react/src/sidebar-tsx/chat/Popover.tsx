/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The one menu primitive of the chat panel: anchored to a button, positioned with fixed strategy (so a scrolling or
// clipping parent never cuts it off), closed by Escape or a click outside it and its anchor, and navigable with the
// arrow keys over its rows (anything with a menuitem role that isn't aria-disabled). It renders in place, not in a
// portal, so it stays inside the panel's style scope.

import React, { useEffect, useRef } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import type { Placement } from '@floating-ui/react';

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

const itemsOf = (root: HTMLElement) =>
	Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(el => el.getAttribute('aria-disabled') !== 'true');

/** Menu rows for a Popover: a full-width button with the menu row look. `checked` makes it a radio row. */
export const MenuRow = ({ children, onSelect, checked, disabled, danger, tooltip, className = '' }: {
	children: React.ReactNode;
	/** a destructive action (shown in the error color) */
	danger?: boolean;
	onSelect: () => void;
	checked?: boolean;
	disabled?: boolean;
	/** shown on hover; for a disabled row, the reason it is disabled */
	tooltip?: string;
	className?: string;
}) => {
	return <button
		type='button'
		role={checked === undefined ? 'menuitem' : 'menuitemradio'}
		aria-checked={checked === undefined ? undefined : checked}
		aria-disabled={disabled ? true : undefined}
		tabIndex={-1}
		data-tooltip-id={tooltip ? 'ze-tooltip' : undefined}
		data-tooltip-content={tooltip}
		data-tooltip-place='right'
		className={`w-full flex items-baseline gap-2 px-2 py-1 rounded-[6px] text-left text-sm outline-none
			${disabled ? 'text-ze-fg-3 opacity-70 cursor-default' : 'cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] focus:bg-[var(--vscode-list-hoverBackground)]'}
			${disabled ? '' : danger ? 'text-[var(--vscode-errorForeground)]' : 'text-ze-fg-1'}
			${checked ? 'bg-[var(--vscode-list-inactiveSelectionBackground)]' : ''}
			${className}`}
		onClick={e => { e.preventDefault(); if (!disabled) { onSelect(); } }}
	>
		{children}
	</button>;
};

/** A section heading inside a Popover. */
export const MenuHeading = ({ children }: { children: React.ReactNode }) => {
	return <div className='px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-ze-fg-3 select-none'>{children}</div>;
};

export const Popover = ({ anchor, open, onClose, children, placement = 'top-start', className = '', label, initialFocus = 'selected', flush = false, maxHeight = 420 }: {
	anchor: HTMLElement | null;
	open: boolean;
	onClose: () => void;
	children: React.ReactNode;
	placement?: Placement;
	/** width and other layout classes for the panel */
	className?: string;
	label?: string;
	/** 'selected': focus the checked row (else the first row) on open; 'none': leave focus to the content (e.g. a search box) */
	initialFocus?: 'selected' | 'none';
	/** no inner padding (the content lays out its own sections) */
	flush?: boolean;
	/** the tallest the panel gets, in px; less when the window has less room */
	maxHeight?: number;
}) => {
	const { refs, floatingStyles } = useFloating({
		open,
		placement,
		strategy: 'fixed',
		elements: { reference: anchor },
		middleware: [
			offset(4),
			flip({ padding: 8 }),
			shift({ padding: 8 }),
			size({
				padding: 8,
				apply({ availableHeight, elements }) {
					elements.floating.style.maxHeight = `${Math.min(maxHeight, Math.max(120, availableHeight))}px`;
				},
			}),
		],
		whileElementsMounted: autoUpdate,
	});

	const panelRef = useRef<HTMLDivElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// a click outside the panel and its anchor closes it (capture phase: buttons that stop propagation still count)
	useEffect(() => {
		if (!open) {
			return;
		}
		const onMouseDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (panelRef.current?.contains(target) || anchor?.contains(target)) {
				return;
			}
			onCloseRef.current();
		};
		document.addEventListener('mousedown', onMouseDown, true);
		return () => document.removeEventListener('mousedown', onMouseDown, true);
	}, [open, anchor]);

	useEffect(() => {
		if (!open || initialFocus === 'none' || !panelRef.current) {
			return;
		}
		const items = itemsOf(panelRef.current);
		const target = items.find(el => el.getAttribute('aria-checked') === 'true') ?? items[0];
		(target ?? panelRef.current).focus({ preventScroll: true });
	}, [open, initialFocus]);

	if (!open) {
		return null;
	}

	const close = () => {
		onCloseRef.current();
		anchor?.focus({ preventScroll: true });
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
			return;
		}
		const root = panelRef.current;
		if (!root) {
			return;
		}
		const active = document.activeElement as HTMLElement | null;
		// leave the keys to controls that use them (a slider); a text field only gives up the up and down arrows
		const isTextField = active?.tagName === 'INPUT' && ((active as HTMLInputElement).type === 'text' || (active as HTMLInputElement).type === 'search');
		const isItem = !!active?.matches(ITEM_SELECTOR) || active === root;
		if (!isItem && !(isTextField && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
			return;
		}
		const items = itemsOf(root);
		if (items.length === 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const idx = active ? items.indexOf(active) : -1;
		const next =
			e.key === 'Home' ? 0
				: e.key === 'End' ? items.length - 1
					: e.key === 'ArrowDown' ? (idx + 1) % items.length
						: idx <= 0 ? items.length - 1 : idx - 1;
		items[next].focus({ preventScroll: false });
	};

	return <div
		ref={el => { panelRef.current = el; refs.setFloating(el); }}
		role='menu'
		aria-label={label}
		tabIndex={-1}
		style={floatingStyles}
		className={`z-[100] flex flex-col ${flush ? '' : 'p-1'} overflow-y-auto outline-none rounded-[10px] border border-ze-border-2 bg-ze-bg-1 text-ze-fg-1 text-root shadow-lg ${className}`}
		onKeyDown={onKeyDown}
		// clicks inside the menu must not reach the input box (which would focus its text area) or the tab strip
		onClick={e => e.stopPropagation()}
		onMouseDown={e => e.stopPropagation()}
	>
		{children}
	</div>;
};
