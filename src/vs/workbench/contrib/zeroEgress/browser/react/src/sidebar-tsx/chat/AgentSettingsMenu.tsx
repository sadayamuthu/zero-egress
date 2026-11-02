/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The input box's ⚙ button and its "Agent settings" menu. All of it is app-wide (globalSettings), the same values the
// full Settings page shows. Allowed commands are this workspace's list.

import React, { useState } from 'react';
import { ChevronLeft, Pencil, Settings, X } from 'lucide-react';
import { useAccessor, useCommandAllowList, useSettingsState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { contextPercent, contextWindowK, settingsForTerminalAutoRun, terminalAutoRunOf, ZERO_EGRESS_OPEN_SETTINGS_ACTION_ID } from '../composerDeps.js';
import type { CustomMode, TerminalAutoRun } from '../composerDeps.js';
import { CustomModeForm, iconOfCustomMode, useCustomModes } from './CustomModeForm.js';
import { MenuHeading, MenuRow, Popover } from './Popover.js';
import { useCompactBusy, useContextUse } from './ContextMeter.js';
import { Segmented } from './Segmented.js';

const SettingRow = ({ label, children }: { label: string; children: React.ReactNode }) => {
	return <div className='flex items-center justify-between gap-2 px-2 py-1 text-sm text-ze-fg-1'>
		<span>{label}</span>
		{children}
	</div>;
};

const terminalOptions: readonly { value: TerminalAutoRun; label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'allowList', label: 'Allow-list' },
	{ value: 'all', label: 'All' },
];
const onOffOptions = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] as const;

export const AgentSettingsMenu = ({ threadId }: { threadId: string }) => {
	const contextUse = useContextUse(threadId);
	const busy = useCompactBusy(threadId);
	const accessor = useAccessor();
	const settingsService = accessor.get('IZeroEgressSettingsService');
	const commandAllowListService = accessor.get('ICommandAllowListService');
	const commandService = accessor.get('ICommandService');
	const globalSettings = useSettingsState().globalSettings;
	const allowed = useCommandAllowList();

	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [showList, setShowList] = useState(false);
	const customModes = useCustomModes();
	// null = the settings, 'list' = the custom modes, otherwise the form (a mode, or 'new')
	const [modesView, setModesView] = useState<null | 'list' | 'new' | CustomMode>(null);
	const close = () => { setOpen(false); setShowList(false); setModesView(null); };

	const terminal = terminalAutoRunOf(globalSettings);
	const setApprove = (key: 'edits' | 'MCP tools', on: boolean) => {
		// keep the other keys of autoApprove, as the full Settings page does
		settingsService.setGlobalSetting('autoApprove', { ...settingsService.state.globalSettings.autoApprove, [key]: on });
	};
	const setTerminal = (v: TerminalAutoRun) => {
		const next = settingsForTerminalAutoRun(v);
		settingsService.setGlobalSetting('autoApprove', { ...settingsService.state.globalSettings.autoApprove, terminal: next.terminal });
		settingsService.setGlobalSetting('useCommandAllowList', next.useCommandAllowList);
	};

	return <>
		<span data-tooltip-id='ze-tooltip' data-tooltip-content='Agent settings' data-tooltip-place='top'>
			<button
				ref={setAnchor}
				type='button'
				aria-haspopup='menu'
				aria-expanded={open}
				aria-label='Agent settings'
				className='size-[22px] flex items-center justify-center rounded-[6px] text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover'
				onClick={e => { e.stopPropagation(); if (open) { close(); } else { setOpen(true); } }}
			>
				<Settings size={13} />
			</button>
		</span>
		<Popover anchor={anchor} open={open} onClose={close} placement='top-end' className='w-72' label='Agent settings' form={modesView !== null && modesView !== 'list'} initialFocus={modesView === null ? 'selected' : 'none'}>
			{modesView === 'list' ? <>
				<MenuRow onSelect={() => setModesView(null)}>
					<ChevronLeft size={12} className='shrink-0 self-center' />
					<span>Custom modes</span>
				</MenuRow>
				{customModes.map(m => {
					const Icon = iconOfCustomMode(m.icon);
					return <div key={m.id} className='flex items-center'>
						<div className='flex-1 min-w-0 flex items-center gap-2 px-2 py-1 text-sm text-ze-fg-1'>
							<Icon size={12} className='shrink-0' />
							<span className='truncate'>{m.name}</span>
						</div>
						<button
							type='button'
							role='menuitem'
							tabIndex={-1}
							aria-label={`Edit ${m.name}`}
							className='shrink-0 size-5 flex items-center justify-center rounded text-ze-fg-3 hover:text-ze-fg-1 hover:bg-[var(--vscode-list-hoverBackground)] focus:bg-[var(--vscode-list-hoverBackground)] outline-none'
							onClick={e => { e.stopPropagation(); setModesView(m); }}
						><Pencil size={11} /></button>
					</div>;
				})}
				<MenuRow onSelect={() => setModesView('new')}>
					<span>New custom mode…</span>
				</MenuRow>
			</> : modesView ? <CustomModeForm mode={modesView === 'new' ? null : modesView} onDone={() => setModesView('list')} /> : <>
			<MenuHeading>Agent settings</MenuHeading>
			<SettingRow label='Auto-run terminal'>
				<Segmented label='Auto-run terminal' value={terminal} options={terminalOptions} onChange={setTerminal} />
			</SettingRow>
			<SettingRow label='Auto-accept edits'>
				<Segmented label='Auto-accept edits' value={globalSettings.autoApprove.edits ? 'on' : 'off'} options={onOffOptions} onChange={v => setApprove('edits', v === 'on')} />
			</SettingRow>
			<SettingRow label='Auto-approve MCP tools'>
				<Segmented label='Auto-approve MCP tools' value={globalSettings.autoApprove['MCP tools'] ? 'on' : 'off'} options={onOffOptions} onChange={v => setApprove('MCP tools', v === 'on')} />
			</SettingRow>
			<MenuRow onSelect={() => setShowList(s => !s)}>
				<span>Allowed commands ({allowed.length})</span>
				<span className='ml-auto text-xs text-ze-fg-3'>{showList ? 'hide' : 'show'}</span>
			</MenuRow>
			{showList ? <div className='px-2 pb-1'>
				{allowed.length === 0
					? <div className='text-xs text-ze-fg-3'>No allowed commands yet. Use “Always allow” on a command to add one.</div>
					: allowed.map(cmd => <div key={cmd} className='flex items-center gap-1 py-0.5'>
						<code className='flex-1 min-w-0 truncate text-xs text-ze-fg-2' title={cmd}>{cmd}</code>
						<button
							type='button'
							role='menuitem'
							tabIndex={-1}
							aria-label={`Remove ${cmd}`}
							className='shrink-0 size-4 flex items-center justify-center rounded text-ze-fg-3 hover:text-ze-fg-1 hover:bg-[var(--vscode-list-hoverBackground)]'
							onClick={e => { e.stopPropagation(); commandAllowListService.remove(cmd); }}
						><X size={11} /></button>
					</div>)}
			</div> : null}
			<MenuRow onSelect={() => setModesView('list')}>
				<span>Custom modes</span>
				<span className='ml-auto text-xs text-ze-fg-3'>{customModes.length} ›</span>
			</MenuRow>
			{contextUse ? <>
				<MenuHeading>Context</MenuHeading>
				<div className='px-2 py-1 text-sm text-ze-fg-1'>{contextUse.estimated ? '≈' : ''}{contextPercent(contextUse)}% of {contextWindowK(contextUse)}k used</div>
				<MenuRow disabled={busy.disabled} onSelect={() => { close(); void accessor.get('IChatThreadService').compactThread(threadId); }}>
					<span>{busy.compacting ? 'Compacting…' : 'Compact'}</span>
				</MenuRow>
			</> : null}
			<MenuRow onSelect={() => { close(); commandService.executeCommand(ZERO_EGRESS_OPEN_SETTINGS_ACTION_ID); }}>
				<span>All settings…</span>
			</MenuRow>
			</>}
		</Popover>
	</>;
};
