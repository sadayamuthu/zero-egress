/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Above a docked chat's input: this chat's pending changes, with Accept all (⌘⏎) and Reject all for them only.
// Files other chats (or no chat) own are counted as "+k from other chats"; clicking that lists them, so they can
// still be opened, accepted or rejected from here. Hidden while this chat owns nothing.

import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { ReviewFile, useThreadReview } from '../useThreadReview.js';

const basenameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

const describe = (f: ReviewFile) => {
	const parts: string[] = [];
	if (f.diffs > 0) {
		parts.push(`${f.diffs} diff${f.diffs === 1 ? '' : 's'}`);
	}
	for (const op of f.ops) {
		parts.push(op.kind === 'create' ? 'new' : 'deleted');
	}
	return parts.join(' · ');
};

const FileRow = ({ file, onOpen, onResolve }: { file: ReviewFile; onOpen: () => void; onResolve: (b: 'accept' | 'reject') => void }) => {
	const isFolder = file.ops.some(op => op.isFolder);
	return <div className='flex justify-between items-center gap-2'>
		<div className='flex items-center gap-2 min-w-0'>
			<span
				className={`truncate text-ze-fg-2 ${isFolder ? '' : 'hover:brightness-125 cursor-pointer'}`}
				onClick={isFolder ? undefined : onOpen}
			>{basenameOf(file.uri.path)}</span>
			<span className='text-ze-fg-3 opacity-80 shrink-0'>{describe(file)}</span>
		</div>
		<div className={`flex items-center gap-0.5 shrink-0 ${file.isStreaming ? 'opacity-0 pointer-events-none' : ''}`}>
			<button type='button' aria-label='Reject file' className='p-0.5 rounded hover:bg-ze-bg-2-hover cursor-pointer' onClick={() => onResolve('reject')}><X size={12} /></button>
			<button type='button' aria-label='Accept file' className='p-0.5 rounded hover:bg-ze-bg-2-hover cursor-pointer' onClick={() => onResolve('accept')}><Check size={12} /></button>
		</div>
	</div>;
};

export const ReviewBar = ({ threadId }: { threadId: string }) => {
	const review = useThreadReview(threadId);
	const [openList, setOpenList] = useState<'mine' | 'others' | null>(null);

	if (review.mine.length === 0) {
		return null;
	}
	const list = openList === 'mine' ? review.mine : openList === 'others' ? review.others : [];
	const toggle = (which: 'mine' | 'others') => setOpenList(openList === which ? null : which);

	return <>
		{list.length > 0 && <div className='px-2'>
			<div className='select-none flex flex-col gap-1 w-full max-h-24 overflow-y-auto rounded-t-lg bg-ze-bg-3 text-ze-fg-3 text-xs text-nowrap px-2 py-1'>
				{list.map(f => <FileRow key={f.path} file={f} onOpen={() => review.openFile(f)} onResolve={b => review.acceptOrRejectFile(f, b)} />)}
			</div>
		</div>}
		<div className='select-none flex w-full items-center justify-between gap-2 rounded-t-[10px] bg-ze-bg-2 text-ze-fg-2 text-xs text-nowrap border-t border-l border-r border-ze-border-2 px-2.5 py-1.5'>
			<div className='flex items-center gap-1 min-w-0'>
				<button type='button' className='truncate cursor-pointer hover:brightness-125' onClick={() => toggle('mine')}>
					{review.changes} changes · {review.mine.length} files
				</button>
				{review.otherFiles > 0 && <button type='button' className='truncate text-ze-fg-3 cursor-pointer hover:brightness-125' onClick={() => toggle('others')}>
					· +{review.otherFiles} from other chats
				</button>}
			</div>
			<div className={`flex items-center gap-1.5 shrink-0 ${review.isStreaming ? 'opacity-50 pointer-events-none' : ''}`}>
				<button
					type='button'
					className='px-2 py-0.5 rounded-[6px] border border-ze-border-2 bg-ze-bg-2 text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer'
					onClick={() => review.acceptOrRejectMine('reject')}
				>Reject all</button>
				<button
					type='button'
					className='px-2 py-0.5 rounded-[6px] bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover font-medium cursor-pointer'
					onClick={() => review.acceptOrRejectMine('accept')}
				>Accept all ⌘⏎</button>
			</div>
		</div>
	</>;
};
