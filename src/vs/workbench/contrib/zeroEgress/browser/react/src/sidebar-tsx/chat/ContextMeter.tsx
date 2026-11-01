/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The input box's context meter: a small bar for how full the selected Chat model's context window is, with a popover
// that offers to compact the chat. The numbers come from the provider's counts on the last reply; before the first
// reply they are an estimate from the text (marked ≈).

import React, { useMemo, useState } from 'react';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useSettingsState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { contextPercent, contextUseOf, contextWindowK, formatContextUse, getModelCapabilities } from '../composerDeps.js';
import type { ContextUse } from '../composerDeps.js';
import { MenuHeading, MenuRow, Popover } from './Popover.js';

/** the chat's context use against the selected Chat model's window; null when no model is selected */
export const useContextUse = (threadId: string): ContextUse | null => {
	const settingsState = useSettingsState();
	const messages = useChatThreadsState().allThreads[threadId]?.messages;
	const sel = settingsState.modelSelectionOfFeature['Chat'];
	const contextWindow = sel ? getModelCapabilities(sel.providerName, sel.modelName, settingsState.overridesOfModel).contextWindow : undefined;
	return useMemo(() => {
		if (!(typeof contextWindow === 'number' && contextWindow > 0 && Number.isFinite(contextWindow))) { return null; }
		// the system prompt is built asynchronously in the browser service, so 0 here: the meter stays ≈ until the first reply
		return contextUseOf(messages ?? [], contextWindow, 0);
	}, [messages, contextWindow]);
};

/** Compact is off while the chat is replying or a summary is being written */
export const useCompactBusy = (threadId: string) => {
	useChatThreadsState(); // re-render when the service says compacting started or ended
	const compacting = useAccessor().get('IChatThreadService').isCompacting(threadId);
	const running = !!useChatThreadsStreamState(threadId)?.isRunning;
	return { compacting, disabled: compacting || running };
};

export const ContextMeter = ({ threadId }: { threadId: string }) => {
	const use = useContextUse(threadId);
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const chatThreadService = useAccessor().get('IChatThreadService');
	const busy = useCompactBusy(threadId);
	if (!use) { return null; }

	const label = formatContextUse(use);
	const used = `${use.estimated ? '≈' : ''}${contextPercent(use)}% of ${contextWindowK(use)}k used`;
	const warn = use.fraction >= 0.8;
	return <>
		<span data-tooltip-id='ze-tooltip' data-tooltip-content={label} data-tooltip-place='top'>
			<button
				ref={setAnchor}
				type='button'
				aria-haspopup='menu'
				aria-expanded={open}
				aria-label={`Context: ${label}`}
				className='h-[22px] px-1 flex items-center justify-center rounded-[6px] hover:bg-ze-bg-2-hover'
				onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
			>
				<span className='block w-9 h-[5px] rounded-full overflow-hidden bg-[var(--vscode-widget-border)]'>
					<span
						className='block h-full rounded-full'
						style={{ width: `${Math.round(use.fraction * 100)}%`, background: warn ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-progressBar-background)' }}
					/>
				</span>
			</button>
		</span>
		<Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement='top-end' className='w-56' label='Context'>
			<MenuHeading>Context</MenuHeading>
			<div className='px-2 py-1 text-sm text-ze-fg-1'>{used}</div>
			<MenuRow disabled={busy.disabled} onSelect={() => { setOpen(false); void chatThreadService.compactThread(threadId); }}>
				<span>{busy.compacting ? 'Compacting…' : 'Compact this chat'}</span>
			</MenuRow>
		</Popover>
	</>;
};
