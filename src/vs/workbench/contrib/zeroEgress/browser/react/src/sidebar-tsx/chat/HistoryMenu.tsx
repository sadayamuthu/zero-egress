/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Every docked chat, newest first, with a title filter. Clicking a row opens it as a tab; each row can be renamed or
// deleted. Background agents live in the Agents view and are not listed.
// TODO(Task 7): move onto the shared Popover; for now a plain absolutely positioned div.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../../util/services.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { threadTitleOf } from '../chatTitle.js';
import { RenameInput, SmallIconButton } from './TabParts.js';

const formatDate = (iso: string) => {
	const date = new Date(iso);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date >= today) {
		return 'Today';
	}
	if (date >= yesterday) {
		return 'Yesterday';
	}
	return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
};

export const HistoryMenu = ({ onClose }: { onClose: () => void }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const { allThreads, currentThreadId } = useChatThreadsState();
	const streamState = useFullChatThreadsStreamState();

	const [query, setQuery] = useState('');
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onMouseDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', onMouseDown);
		return () => document.removeEventListener('mousedown', onMouseDown);
	}, [onClose]);

	const rows = useMemo(() => {
		const q = query.trim().toLowerCase();
		return Object.values(allThreads)
			.filter((t): t is NonNullable<typeof t> => !!t && !t.agent)
			.filter(t => t.messages.length > 0 || t.id === currentThreadId || !!t.title)
			.map(t => ({ thread: t, title: threadTitleOf(t) }))
			.filter(r => !q || r.title.toLowerCase().includes(q))
			.sort((a, b) => (a.thread.lastModified < b.thread.lastModified ? 1 : a.thread.lastModified > b.thread.lastModified ? -1 : 0));
	}, [allThreads, currentThreadId, query]);

	return <div
		ref={ref}
		className='absolute left-1 right-1 ml-auto max-w-72 top-full mt-1 z-[100] max-h-96 flex flex-col rounded border border-ze-border-3 bg-ze-bg-1 shadow-md text-root text-ze-fg-1'
		onKeyDown={e => { if (e.key === 'Escape' && renamingId === null) { e.stopPropagation(); onClose(); } }}
	>
		<div className='p-1.5 border-b border-ze-border-3'>
			<input
				autoFocus
				className='w-full px-1.5 py-1 rounded text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border,transparent)] outline-none focus:border-[var(--vscode-focusBorder)]'
				placeholder='Search chats'
				value={query}
				onChange={e => setQuery(e.target.value)}
			/>
		</div>
		<div className='overflow-y-auto py-1'>
			{rows.length === 0 ? <div className='px-2 py-1.5 text-sm text-ze-fg-3 select-none'>{query ? 'No matching chats' : 'No chats yet'}</div> : null}
			{rows.map(({ thread, title }) => {
				const isRunning = !!streamState[thread.id]?.isRunning;
				const isCurrent = thread.id === currentThreadId;
				return <div
					key={thread.id}
					className={`group flex items-center justify-between gap-2 px-2 py-1 mx-1 rounded cursor-pointer hover:bg-ze-bg-2-hover ${isCurrent ? 'bg-ze-bg-2' : ''}`}
					onClick={() => { if (renamingId !== thread.id) { chatThreadsService.switchToThread(thread.id); onClose(); } }}
				>
					<span className='flex items-center gap-1.5 min-w-0'>
						{isRunning ? <span className='size-1.5 rounded-full bg-ze-accent shrink-0' /> : null}
						{renamingId === thread.id
							? <RenameInput
								initial={thread.title ?? title}
								onDone={value => { if (value !== null) { chatThreadsService.renameThread(thread.id, value); } setRenamingId(null); }}
							/>
							: <span className='truncate'>{title}</span>}
					</span>
					<span className='flex items-center gap-0.5 shrink-0 text-ze-fg-3'>
						{confirmDeleteId === thread.id
							? <>
								<SmallIconButton Icon={X} label='Cancel' onClick={() => setConfirmDeleteId(null)} />
								<SmallIconButton Icon={Check} label='Confirm delete' onClick={() => { chatThreadsService.deleteThread(thread.id).catch(e => console.error('Error while deleting a chat:', e)); setConfirmDeleteId(null); }} />
							</>
							: <>
								<span className='text-xs opacity-80 group-hover:hidden'>{formatDate(thread.lastModified)}</span>
								<span className='hidden group-hover:flex items-center gap-0.5'>
									<SmallIconButton Icon={Pencil} label='Rename' onClick={() => setRenamingId(thread.id)} />
									<SmallIconButton Icon={Trash2} label='Delete' onClick={() => setConfirmDeleteId(thread.id)} />
								</span>
							</>}
					</span>
				</div>;
			})}
		</div>
	</div>;
};
