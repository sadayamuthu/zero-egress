/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The card a terminal tool request waits on: the command in mono, then Run (⏎), Skip and Always allow “<command>”.
// ⏎ runs only while the user has put focus on the card (a click or Tab); the card never takes focus by itself.
// Enter on a focused button presses that button.
// ApprovalCardShell is the shared frame; the other approval types (edits, MCP tools) use it with Approve/Reject.

import React, { useCallback } from 'react';
import type { ToolMessage } from '../../../../../common/chatThreadServiceTypes.js';
import type { ToolName } from '../../../../../common/toolsServiceTypes.js';
import { useAccessor, useSettingsState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { canAllowList, normalizeCommand, terminalAutoRunOf } from '../composerDeps.js';

// the class lists stay inside JSX className: the scope-tailwind pass only prefixes classes written there
export const ApprovalButton = ({ primary, className = '', ...props }: { primary?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return primary
		? <button type='button' className={`px-2 py-0.5 rounded-[6px] text-xs font-medium bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover cursor-pointer disabled:opacity-50 ${className}`} {...props} />
		: <button type='button' className={`px-2 py-0.5 rounded-[6px] text-xs border border-ze-border-2 bg-ze-bg-2 text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer disabled:opacity-50 min-w-0 truncate ${className}`} {...props} />;
};

export const ApprovalCardShell = ({ title, children, buttons, onEnter }: {
	title: React.ReactNode;
	children?: React.ReactNode;
	buttons: React.ReactNode;
	/** ⏎ while the card itself is focused (by the user); leave out for a card without a key */
	onEnter?: () => void;
}) => {
	return <div
		tabIndex={onEnter ? 0 : undefined}
		className='mx-0.5 my-1 px-2.5 py-2 rounded-[10px] border border-ze-border-2 bg-[color-mix(in_srgb,var(--ze-warning)_8%,var(--ze-bg-2))] text-ze-fg-1 flex flex-col gap-1.5 outline-none focus:border-ze-accent'
		onKeyDown={onEnter ? e => {
			// only the card itself: Enter on a focused button presses that button
			if (e.target !== e.currentTarget || e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) { return; }
			e.preventDefault();
			e.stopPropagation();
			onEnter();
		} : undefined}
	>
		<div className='text-sm font-medium'>{title}</div>
		{children}
		<div className='flex flex-wrap items-center gap-1.5'>{buttons}</div>
	</div>;
};

export const ApprovalCard = ({ threadId, toolMessage }: {
	threadId: string;
	toolMessage: ToolMessage<'run_command' | 'run_persistent_command'> & { type: 'tool_request' };
}) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const commandAllowListService = accessor.get('ICommandAllowListService');
	const metricsService = accessor.get('IMetricsService');

	const command = toolMessage.params.command;

	const onRun = useCallback(() => {
		try {
			chatThreadsService.approveLatestToolRequest(threadId);
			metricsService.capture('Tool Request Accepted', {});
		} catch (e) { console.error('Error while approving a command in chat:', e); }
	}, [chatThreadsService, metricsService, threadId]);
	const onSkip = useCallback(() => {
		try {
			chatThreadsService.rejectLatestToolRequest(threadId);
		} catch (e) { console.error('Error while skipping a command in chat:', e); }
		metricsService.capture('Tool Request Rejected', {});
	}, [chatThreadsService, metricsService, threadId]);
	const onAlwaysAllow = useCallback(() => {
		try {
			commandAllowListService.add(command);
		} catch (e) { console.error('Error while allowing a command in chat:', e); }
		onRun();
	}, [commandAllowListService, command, onRun]);

	const allowLabel = `Always allow “${normalizeCommand(command)}”`;
	// with Auto-run terminal Off the allow-list is not consulted, so adding to it would change nothing
	const autoRunIsOff = terminalAutoRunOf(useSettingsState().globalSettings) === 'off';

	return <ApprovalCardShell
		title='Run this command?'
		onEnter={onRun}
		buttons={<>
			<ApprovalButton primary onClick={onRun}>
				Run <span className='ml-0.5 opacity-70'>⏎</span>
			</ApprovalButton>
			<ApprovalButton onClick={onSkip}>Skip</ApprovalButton>
			{!autoRunIsOff && canAllowList(command) && <ApprovalButton
				className='max-w-full'
				onClick={onAlwaysAllow}
				data-tooltip-id='ze-tooltip'
				data-tooltip-place='top'
				data-tooltip-content={allowLabel}
				data-tooltip-delay-show={600}
			>{allowLabel}</ApprovalButton>}
		</>}
	>
		<div className='font-mono text-xs px-2 py-1 rounded-[6px] border border-ze-border-2 bg-ze-bg-1 whitespace-pre-wrap break-all select-text max-h-40 overflow-y-auto'>{command}</div>
	</ApprovalCardShell>;
};
