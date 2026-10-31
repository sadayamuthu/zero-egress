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
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { threadTitleOf } from '../chatTitle.js';
import { ApprovalButton } from './ApprovalCard.js';

const basenameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

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
	const otherThread = chatThreadsState.allThreads[conflict.ownerThreadId];
	const otherTitle = otherThread ? threadTitleOf(otherThread) : 'New chat';

	return <div className='mx-0.5 my-1 px-2.5 py-2 rounded-[10px] border border-ze-border-2 bg-[color-mix(in_srgb,var(--ze-warning)_8%,var(--ze-bg-2))] text-ze-fg-1 flex flex-col gap-2'>
		<div className='flex items-start gap-1.5 text-sm'>
			<AlertTriangle size={14} className='text-ze-warning shrink-0 mt-0.5' />
			<span>{file} has unreviewed changes from “{otherTitle}”.</span>
		</div>
		<div className='flex flex-wrap gap-1.5'>
			<ApprovalButton primary disabled={busy} onClick={() => resolve('accept')}>Accept theirs & continue</ApprovalButton>
			<ApprovalButton disabled={busy} onClick={() => resolve('reject')}>Reject theirs & continue</ApprovalButton>
			<ApprovalButton disabled={busy} onClick={stop}>Stop</ApprovalButton>
		</div>
	</div>;
};
