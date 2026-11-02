/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Create or edit a custom mode, inside a Popover (give that Popover `form` and initialFocus='none'). Modes are stored
// in the app settings (globalSettings.customModes), never in the project. Escape (handled by the Popover) cancels.

import React, { useState } from 'react';
import { BookOpen, Bug, Eye, PenLine, Rocket, Shield, Sparkles, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAccessor, useSettingsState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { validateCustomMode } from '../composerDeps.js';
import type { CustomMode, CustomModeIcon } from '../composerDeps.js';
import { onRadioGroupKeyDown } from './Popover.js';

export const customModeIcons: readonly { icon: CustomModeIcon; label: string; Icon: LucideIcon }[] = [
	{ icon: 'sparkles', label: 'Sparkles', Icon: Sparkles },
	{ icon: 'shield', label: 'Shield', Icon: Shield },
	{ icon: 'eye', label: 'Eye', Icon: Eye },
	{ icon: 'wrench', label: 'Wrench', Icon: Wrench },
	{ icon: 'book', label: 'Book', Icon: BookOpen },
	{ icon: 'bug', label: 'Bug', Icon: Bug },
	{ icon: 'rocket', label: 'Rocket', Icon: Rocket },
	{ icon: 'pen', label: 'Pen', Icon: PenLine },
];

export const iconOfCustomMode = (icon: CustomModeIcon): LucideIcon => customModeIcons.find(i => i.icon === icon)?.Icon ?? Sparkles;

/** the saved custom modes (stored data may be malformed: only well-formed entries are listed) */
export const useCustomModes = (): CustomMode[] => {
	const { customModes } = useSettingsState().globalSettings;
	return Array.isArray(customModes) ? customModes.filter(m => !!m && typeof m.id === 'string') : [];
};

const fieldClass = 'w-full px-2 py-1 rounded-[6px] text-sm text-ze-fg-1 bg-ze-bg-2 border border-ze-border-2 outline-none focus:border-[var(--vscode-focusBorder)]';
const buttonClass = 'px-2 py-1 rounded-[6px] text-sm hover:bg-[var(--vscode-list-hoverBackground)] outline-none focus-visible:bg-[var(--vscode-list-hoverBackground)]';

export const CustomModeForm = ({ mode, onDone }: { mode: CustomMode | null; onDone: () => void }) => {
	const settingsService = useAccessor().get('IZeroEgressSettingsService');
	const modes = useCustomModes();
	const [draft, setDraft] = useState<CustomMode>(() => mode ?? {
		id: globalThis.crypto.randomUUID(), name: '', icon: 'sparkles', tools: { edit: false, terminal: false, mcp: false }, instructions: '',
	});
	const [tried, setTried] = useState(false);
	const error = validateCustomMode(draft, modes);

	const setTool = (key: 'edit' | 'terminal' | 'mcp', on: boolean) => setDraft(d => ({ ...d, tools: { ...d.tools, [key]: on } }));

	const save = () => {
		setTried(true);
		if (error) { return; }
		const next = { ...draft, name: draft.name.trim() };
		const exists = modes.some(m => m.id === next.id);
		void settingsService.setGlobalSetting('customModes', exists ? modes.map(m => m.id === next.id ? next : m) : [...modes, next]);
		// a new mode is picked right away
		if (!exists) { void settingsService.setGlobalSetting('activeCustomModeId', next.id); }
		onDone();
	};
	const remove = () => {
		void settingsService.setGlobalSetting('customModes', modes.filter(m => m.id !== draft.id));
		// the built-in mode applies again when the deleted one was active
		if (settingsService.state.globalSettings.activeCustomModeId === draft.id) { void settingsService.setGlobalSetting('activeCustomModeId', null); }
		onDone();
	};

	return <form className='flex flex-col gap-2 p-2' onSubmit={e => { e.preventDefault(); save(); }}>
		<label className='flex flex-col gap-0.5 text-xs text-ze-fg-3'>
			Name
			<input
				type='text'
				autoFocus
				className={fieldClass}
				value={draft.name}
				aria-invalid={tried && !!error}
				onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
			/>
		</label>
		<div className='flex flex-col gap-0.5 text-xs text-ze-fg-3'>
			<span id='ze-custom-mode-icon'>Icon</span>
			<div role='radiogroup' aria-labelledby='ze-custom-mode-icon' className='flex flex-wrap gap-1' onKeyDown={e => onRadioGroupKeyDown(e, i => setDraft(d => ({ ...d, icon: customModeIcons[i].icon })))}>
				{customModeIcons.map(({ icon, label, Icon }) => <button
					key={icon}
					type='button'
					role='radio'
					aria-checked={draft.icon === icon}
					aria-label={label}
					tabIndex={draft.icon === icon ? 0 : -1}
					className={`size-6 flex items-center justify-center rounded-[6px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--vscode-focusBorder)] ${draft.icon === icon ? 'bg-[var(--vscode-list-inactiveSelectionBackground)] text-ze-fg-1' : 'text-ze-fg-3 hover:text-ze-fg-1 hover:bg-[var(--vscode-list-hoverBackground)]'}`}
					onClick={() => setDraft(d => ({ ...d, icon }))}
				><Icon size={13} /></button>)}
			</div>
		</div>
		<fieldset className='flex flex-col gap-0.5 border-0 p-0 m-0 min-w-0'>
			<legend className='text-xs text-ze-fg-3 p-0 mb-0.5'>Tools</legend>
			<label className='flex items-center gap-2 text-sm text-ze-fg-3'><input type='checkbox' checked disabled /> Read</label>
			<label className='flex items-center gap-2 text-sm text-ze-fg-1'><input type='checkbox' checked={draft.tools.edit} onChange={e => setTool('edit', e.target.checked)} /> Edit</label>
			<label className='flex items-center gap-2 text-sm text-ze-fg-1'><input type='checkbox' checked={draft.tools.terminal} onChange={e => setTool('terminal', e.target.checked)} /> Terminal</label>
			<label className='flex items-center gap-2 text-sm text-ze-fg-1'><input type='checkbox' checked={draft.tools.mcp} onChange={e => setTool('mcp', e.target.checked)} /> MCP</label>
		</fieldset>
		<label className='flex flex-col gap-0.5 text-xs text-ze-fg-3'>
			Instructions
			<textarea
				rows={4}
				className={`${fieldClass} resize-y`}
				value={draft.instructions}
				onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))}
			/>
		</label>
		<div className='text-xs text-ze-fg-3'>Saved in the app settings, never in the project.</div>
		{tried && error ? <div role='alert' className='text-xs text-[var(--vscode-errorForeground)]'>{error}</div> : null}
		<div className='flex items-center gap-1'>
			{mode ? <button type='button' className={`${buttonClass} text-[var(--vscode-errorForeground)]`} onClick={remove}>Delete mode</button> : null}
			<span className='ml-auto' />
			<button type='button' className={`${buttonClass} text-ze-fg-1`} onClick={onDone}>Cancel</button>
			<button type='submit' className={`${buttonClass} text-ze-fg-1 font-medium`}>Save</button>
		</div>
	</form>;
};
