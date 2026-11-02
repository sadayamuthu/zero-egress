/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The / menu: opens above the composer while the text is a slash and the start of a command name. It takes its
// rows as sections (a heading and its commands), so more sections can follow the built-in ones. Focus stays in the
// text area: the composer's key handler moves the highlight (↑/↓), picks (⏎ runs, Tab completes) and closes (Escape).

import React from 'react';
import { MenuHeading, MenuRow, Popover } from './Popover.js';

export type SlashItem = { name: string; detail: string; /** shown on hover */ title?: string };
export type SlashSection = { heading: string; items: readonly SlashItem[] };

/** the rows in the order ↑/↓ walk them */
export const flattenSlashSections = (sections: readonly SlashSection[]): SlashItem[] => sections.flatMap(s => s.items);

export const SlashMenu = ({ anchor, open, sections, activeIdx, onPick, onClose }: {
	anchor: HTMLElement | null;
	open: boolean;
	sections: readonly SlashSection[];
	activeIdx: number;
	onPick: (item: SlashItem) => void;
	onClose: () => void;
}) => {
	let n = 0;
	return <Popover anchor={anchor} open={open} onClose={onClose} placement='top-start' className='w-72' label='Commands' initialFocus='none'>
		{sections.filter(s => s.items.length > 0).map(section => <React.Fragment key={section.heading}>
			<MenuHeading>{section.heading}</MenuHeading>
			{section.items.map(item => {
				const idx = n++;
				return <MenuRow
					key={item.name}
					className={idx === activeIdx ? 'bg-[var(--vscode-list-hoverBackground)]' : ''}
					onSelect={() => onPick(item)}
				>
					<span className='font-medium' title={item.title}>/{item.name}</span>
					<span className='ml-auto text-xs text-ze-fg-3'>{item.detail}</span>
				</MenuRow>;
			})}
		</React.Fragment>)}
	</Popover>;
};
