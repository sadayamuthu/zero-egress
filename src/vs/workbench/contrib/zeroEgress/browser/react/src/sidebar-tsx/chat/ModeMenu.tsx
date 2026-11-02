/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The input box's mode button and menu. "Mode" writes the app-wide globalSettings.chatMode (a running chat keeps the
// mode it started with). "Run in" is the docked panel's: on an empty chat it picks where the first message runs (the
// composer owns that choice); on a chat with messages, Background moves the chat to a background agent.

import React, { useState } from 'react';
import { ChevronDown, Infinity as InfinityIcon, ListChecks, MessageCircle, Pencil, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAccessor, useSettingsState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { selectBuiltInMode } from '../composerDeps.js';
import type { ChatMode, CustomMode } from '../composerDeps.js';
import { CustomModeForm, iconOfCustomMode, useCustomModes } from './CustomModeForm.js';
import { MenuHeading, MenuRow, Popover } from './Popover.js';

export const modeOptions: readonly { mode: ChatMode; label: string; detail: string; Icon: LucideIcon }[] = [
	{ mode: 'agent', label: 'Agent', detail: 'edits, runs', Icon: InfinityIcon },
	{ mode: 'plan', label: 'Plan', detail: 'plan, then wait', Icon: ListChecks },
	{ mode: 'gather', label: 'Gather', detail: 'read only', Icon: Search },
	{ mode: 'normal', label: 'Chat', detail: 'no tools', Icon: MessageCircle },
];

export type RunIn = 'folder' | 'background';

/** The "Run in" section (docked panel only; the Agents view leaves it out). */
export interface RunInSection {
	/** why no background agent can start here (checking, or not a git folder); null when they can */
	readonly unavailableReason: string | null;
	/** the chat has no user message yet: Background only changes where the first message goes */
	readonly isEmptyChat: boolean;
	readonly value: RunIn;
	onChange(value: RunIn): void;
	/** for a chat with messages: why it can't move now (null when it can) */
	readonly moveDisabledReason: string | null;
	readonly isMoving: boolean;
	onMove(): void;
}

/** the look of the buttons that open the input box's menus (the class list stays in JSX so the style scoping sees it) */
export const MenuButton = ({ buttonRef, open, label, onToggle, shrinks = false, children }: {
	buttonRef: (el: HTMLButtonElement | null) => void;
	/** gives up width (its text truncates) when the row is narrow; otherwise it keeps its size */
	shrinks?: boolean;
	open: boolean;
	label: string;
	onToggle: () => void;
	children: React.ReactNode;
}) => {
	return <button
		ref={buttonRef}
		type='button'
		aria-haspopup='menu'
		aria-expanded={open}
		aria-label={label}
		className={`flex items-center gap-1 h-5 px-1.5 rounded-[6px] text-xs text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover select-none whitespace-nowrap ${shrinks ? 'min-w-[48px] overflow-hidden' : 'shrink-0'}`}
		onClick={e => { e.stopPropagation(); onToggle(); }}
	>
		{children}
	</button>;
};

export const ModeMenu = ({ variant, runIn }: { variant: 'docked' | 'agents'; runIn?: RunInSection }) => {
	const accessor = useAccessor();
	const settingsService = accessor.get('IZeroEgressSettingsService');
	const { chatMode, activeCustomModeId } = useSettingsState().globalSettings;
	const customModes = useCustomModes();
	// the form swaps in for the list: null = list, otherwise the mode being edited ('new' for a new one)
	const [editing, setEditing] = useState<CustomMode | 'new' | null>(null);
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);

	const activeCustom = activeCustomModeId ? customModes.find(m => m.id === activeCustomModeId) : undefined;
	const current = activeCustom
		? { label: activeCustom.name, Icon: iconOfCustomMode(activeCustom.icon) }
		: modeOptions.find(o => o.mode === chatMode) ?? modeOptions[0];
	const showRunIn = variant === 'docked' && !!runIn;
	const close = () => { setOpen(false); setEditing(null); anchor?.focus({ preventScroll: true }); };

	return <>
		<MenuButton buttonRef={setAnchor} open={open} label={`Mode: ${current.label}`} onToggle={() => { setOpen(o => !o); setEditing(null); }}>
			<current.Icon size={12} className='shrink-0' />
			<span className='truncate max-w-[96px]'>{current.label}</span>
			<ChevronDown size={12} className='shrink-0 opacity-70' />
		</MenuButton>
		<Popover anchor={anchor} open={open} onClose={() => { setOpen(false); setEditing(null); }} placement='top-start' className='w-60' label='Mode' form={!!editing} initialFocus={editing ? 'none' : 'selected'} maxHeight={640}>
			{editing ? <CustomModeForm mode={editing === 'new' ? null : editing} onDone={close} /> : <>
			<MenuHeading>Mode</MenuHeading>
			{modeOptions.map(o => <MenuRow
				key={o.mode}
				checked={!activeCustom && o.mode === chatMode}
				onSelect={() => { void selectBuiltInMode(settingsService, o.mode); close(); }}
			>
				<o.Icon size={12} className='shrink-0 self-center' />
				<span className='font-medium'>{o.label}</span>
				<span className='ml-auto text-xs text-ze-fg-3'>{o.detail}</span>
			</MenuRow>)}
			{customModes.map(m => {
				const Icon = iconOfCustomMode(m.icon);
				return <div key={m.id} className='flex items-center'>
					<MenuRow
						className='flex-1 min-w-0'
						checked={m.id === activeCustom?.id}
						onSelect={() => { settingsService.setGlobalSetting('activeCustomModeId', m.id); close(); }}
					>
						<Icon size={12} className='shrink-0 self-center' />
						<span className='font-medium truncate'>{m.name}</span>
					</MenuRow>
					<button
						type='button'
						role='menuitem'
						tabIndex={-1}
						aria-label={`Edit ${m.name}`}
						className='shrink-0 size-5 flex items-center justify-center rounded text-ze-fg-3 hover:text-ze-fg-1 hover:bg-[var(--vscode-list-hoverBackground)] focus:bg-[var(--vscode-list-hoverBackground)] outline-none'
						onClick={e => { e.stopPropagation(); setEditing(m); }}
					><Pencil size={11} /></button>
				</div>;
			})}
			<MenuRow onSelect={() => setEditing('new')}>
				<span>Custom mode…</span>
			</MenuRow>
			{showRunIn ? <>
				<MenuHeading>Run in</MenuHeading>
				<MenuRow
					checked={runIn.isEmptyChat ? runIn.value === 'folder' : true}
					onSelect={() => { if (runIn.isEmptyChat) { runIn.onChange('folder'); } close(); }}
				>
					<span>This folder</span>
				</MenuRow>
				{runIn.isEmptyChat
					? <MenuRow
						checked={runIn.value === 'background'}
						disabled={!!runIn.unavailableReason}
						note={runIn.unavailableReason ?? undefined}
						onSelect={() => { runIn.onChange('background'); close(); }}
					>
						<span>Background</span>
						<span className='ml-auto text-xs text-ze-fg-3'>own worktree</span>
					</MenuRow>
					: <MenuRow
						checked={false}
						disabled={!!runIn.moveDisabledReason || runIn.isMoving}
						note={runIn.moveDisabledReason ?? undefined}
						tooltip={runIn.moveDisabledReason ? undefined : 'Move this chat to a background agent'}
						onSelect={() => { close(); runIn.onMove(); }}
					>
						<span>Background</span>
						<span className='ml-auto text-xs text-ze-fg-3'>{runIn.isMoving ? 'moving…' : 'own worktree'}</span>
					</MenuRow>}
			</> : null}
			</>}
		</Popover>
	</>;
};
