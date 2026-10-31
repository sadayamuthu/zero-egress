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
import { RenameInput, SmallIconButton } from './TabParts.js';

const useCloseOnOutsideClick = (open: boolean, onClose: () => void) => {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		const onMouseDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', onMouseDown);
		return () => document.removeEventListener('mousedown', onMouseDown);
	}, [open, onClose]);
	return ref;
};

const MoreMenu = ({ threadId, onRename, onClose }: { threadId: string; onRename: () => void; onClose: () => void }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ref = useCloseOnOutsideClick(true, onClose);

	const item = 'w-full text-left px-2 py-1 rounded text-sm hover:bg-ze-bg-2-hover';
	return <div
		ref={ref}
		role='menu'
		className='absolute right-1 top-full mt-1 z-[100] w-40 p-1 flex flex-col rounded border border-ze-border-3 bg-ze-bg-1 shadow-md text-ze-fg-1'
		onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
	>
		<button type='button' role='menuitem' className={item} onClick={() => { onClose(); onRename(); }}>Rename</button>
		<button type='button' role='menuitem' className={item} onClick={() => { onClose(); chatThreadsService.duplicateThread(threadId); }}>Duplicate</button>
		{confirmDelete
			? <button type='button' role='menuitem' className={`${item} text-[var(--vscode-errorForeground)]`} onClick={() => { onClose(); chatThreadsService.deleteThread(threadId); }}>Confirm delete</button>
			: <button type='button' role='menuitem' className={item} onClick={() => setConfirmDelete(true)}>Delete</button>}
	</div>;
};

export const ChatTabs = () => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const { allThreads, currentThreadId, openTabIds } = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();

	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<'history' | 'more' | null>(null);
	const closeMenu = useCallback(() => setOpenMenu(null), []);

	// keep the current tab in view when it changes (new chat, history, keyboard)
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	useEffect(() => {
		tabRefs.current.get(currentThreadId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [currentThreadId]);

	const tabs = openTabIds.filter(id => allThreads[id] && !allThreads[id]?.agent);

	return <div className='relative flex items-center gap-1 px-1 h-8 shrink-0 border-b border-ze-border-3 select-none'>
		<div role='tablist' className='flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]'>
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
			<SmallIconButton Icon={History} label='History' onClick={() => setOpenMenu(m => m === 'history' ? null : 'history')} />
			<SmallIconButton Icon={Ellipsis} label='More actions' onClick={() => setOpenMenu(m => m === 'more' ? null : 'more')} />
		</div>
		{openMenu === 'history' ? <HistoryMenu onClose={closeMenu} /> : null}
		{openMenu === 'more' ? <MoreMenu threadId={currentThreadId} onRename={() => setRenamingId(currentThreadId)} onClose={closeMenu} /> : null}
	</div>;
};
