/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shown instead of the approval card when a docked chat's file tool targets a path with another chat's unreviewed
// changes. It is never auto-approved: the user accepts or rejects the other chat's changes and continues, or stops.

import React, { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolMessage } from '../../../../../common/chatThreadServiceTypes.js';
import { ToolName } from '../../../../../common/toolsServiceTypes.js';
import { useAccessor, useChatThreadsState } from '../../util/services.js';

const TITLE_MAX = 40;

// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
const basenameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

// TODO(Task 6): use threadTitleOf
const titleOfThread = (thread: { messages: readonly { role: string; displayContent?: string }[] } | undefined): string => {
	const first = thread?.messages.find(m => m.role === 'user')?.displayContent?.trim();
	if (!first) {
		return 'New chat';
	}
	return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first;
};

export const ConflictCard = ({ threadId, toolMessage }: { threadId: string; toolMessage: ToolMessage<ToolName> & { type: 'tool_request' } }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const chatThreadsState = useChatThreadsState();
	const [busy, setBusy] = useState(false);

	const conflict = toolMessage.conflict;
	const resolve = useCallback(async (choice: 'accept' | 'reject') => {
		setBusy(true);
		try {
			await chatThreadsService.resolveConflictAndContinue(threadId, choice);
		} catch (e) {
			console.error('Error while resolving a conflict in chat:', e);
		} finally {
			setBusy(false);
		}
	}, [chatThreadsService, threadId]);
	const stop = useCallback(() => {
		try {
			chatThreadsService.rejectLatestToolRequest(threadId);
		} catch (e) { console.error('Error while stopping a conflicting tool call in chat:', e); }
	}, [chatThreadsService, threadId]);

	if (!conflict) {
		return null;
	}
	const file = basenameOf(conflict.uri.path);
	const otherTitle = titleOfThread(chatThreadsState.allThreads[conflict.ownerThreadId]);

	const primary = `px-2 py-1 rounded text-sm font-medium bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50`;
	const secondary = `px-2 py-1 rounded text-sm font-medium bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50`;

	return <div className='mx-0.5 my-1 p-2 rounded border border-ze-border-2 bg-ze-bg-2-alt text-ze-fg-1 flex flex-col gap-2'>
		<div className='flex items-start gap-1.5 text-sm'>
			<AlertTriangle size={14} className='text-ze-warning shrink-0 mt-0.5' />
			<span>{file} has unreviewed changes from “{otherTitle}”.</span>
		</div>
		<div className='flex flex-wrap gap-2'>
			<button className={primary} disabled={busy} onClick={() => resolve('accept')}>Accept theirs & continue</button>
			<button className={secondary} disabled={busy} onClick={() => resolve('reject')}>Reject theirs & continue</button>
			<button className={secondary} disabled={busy} onClick={stop}>Stop</button>
		</div>
	</div>;
};
