/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The docked chat panel's header: one tab per open chat (an accent dot while it runs; double-click renames), then
// ＋ (new chat), ⏱ (history) and ⋯ (Rename, Duplicate, Delete for the current chat). Closing a tab keeps the chat in
// history with its changes; deleting it releases them. Background agents never get a tab (the Agents view has them).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Ellipsis, History, Plus, X } from 'lucide-react';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { threadTitleOf } from '../chatTitle.js';
import { HistoryMenu } from './HistoryMenu.js';
import { MenuRow, Popover } from './Popover.js';
import { RenameInput, SmallIconButton } from './TabParts.js';

const MoreMenu = ({ anchor, threadId, onRename, onClose }: { anchor: HTMLElement | null; threadId: string; onRename: () => void; onClose: () => void }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const [confirmDelete, setConfirmDelete] = useState(false);

	return <Popover anchor={anchor} open={true} onClose={onClose} placement='bottom-end' className='w-40' label='More actions'>
		<MenuRow onSelect={() => { onClose(); onRename(); }}>Rename</MenuRow>
		<MenuRow onSelect={() => { onClose(); chatThreadsService.duplicateThread(threadId); }}>Duplicate</MenuRow>
		{confirmDelete
			? <MenuRow danger onSelect={() => { onClose(); chatThreadsService.deleteThread(threadId).catch(e => console.error('Error while deleting a chat:', e)); }}>Confirm delete</MenuRow>
			: <MenuRow onSelect={() => setConfirmDelete(true)}>Delete</MenuRow>}
	</Popover>;
};

export const ChatTabs = () => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const { allThreads, currentThreadId, openTabIds } = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();

	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<'history' | 'more' | null>(null);
	const closeMenu = useCallback(() => setOpenMenu(null), []);
	const [historyButton, setHistoryButton] = useState<HTMLButtonElement | null>(null);
	const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);

	// keep the current tab in view when it changes (new chat, history, keyboard)
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	useEffect(() => {
		tabRefs.current.get(currentThreadId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [currentThreadId]);

	const tabs = openTabIds.filter(id => allThreads[id] && !allThreads[id]?.agent);

	return <div className='relative flex items-center gap-1 px-1 h-8 shrink-0 border-b border-ze-border-3 select-none'>
		<div role='tablist' className='flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto overflow-y-hidden' style={{ scrollbarWidth: 'none' }}>
			{tabs.map(id => {
				const thread = allThreads[id]!;
				const title = threadTitleOf(thread);
				const isCurrent = id === currentThreadId;
				const isRunning = !!streamState[id]?.isRunning;
				return <div
					key={id}
					ref={el => { if (el) { tabRefs.current.set(id, el); } else { tabRefs.current.delete(id); } }}
					role='tab'
					aria-selected={isCurrent}
					title={title}
					className={`group flex items-center gap-1 h-6 pl-2 pr-0.5 max-w-40 shrink-0 rounded cursor-pointer text-sm
						${isCurrent ? 'bg-ze-bg-1 text-ze-fg-1' : 'text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover'}`}
					onClick={() => { if (!isCurrent) { chatThreadsService.switchToThread(id); } }}
					onDoubleClick={() => setRenamingId(id)}
					onAuxClick={e => { if (e.button === 1) { e.preventDefault(); chatThreadsService.closeTab(id); } }}
				>
					{isRunning ? <span aria-label='Running' className='size-1.5 rounded-full bg-ze-accent shrink-0' /> : null}
					{renamingId === id
						? <RenameInput
							initial={thread.title ?? title}
							onDone={value => { if (value !== null) { chatThreadsService.renameThread(id, value); } setRenamingId(null); }}
						/>
						: <span className='truncate'>{title}</span>}
					<SmallIconButton
						Icon={X}
						label='Close tab'
						className={isCurrent ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}
						onClick={() => chatThreadsService.closeTab(id)}
					/>
				</div>;
			})}
		</div>
		<div className='flex items-center gap-0.5 shrink-0'>
			<SmallIconButton Icon={Plus} label='New chat' onClick={() => { setOpenMenu(null); chatThreadsService.openNewThread(); }} />
			<SmallIconButton Icon={History} label='History' buttonRef={setHistoryButton} expanded={openMenu === 'history'} onClick={() => setOpenMenu(m => m === 'history' ? null : 'history')} />
			<SmallIconButton Icon={Ellipsis} label='More actions' buttonRef={setMoreButton} expanded={openMenu === 'more'} onClick={() => setOpenMenu(m => m === 'more' ? null : 'more')} />
		</div>
		{openMenu === 'history' ? <HistoryMenu anchor={historyButton} onClose={closeMenu} /> : null}
		{openMenu === 'more' ? <MoreMenu anchor={moreButton} threadId={currentThreadId} onRename={() => setRenamingId(currentThreadId)} onClose={closeMenu} /> : null}
	</div>;
};
