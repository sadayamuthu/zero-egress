/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// One chat's share of the pending changes: what its review bar shows and what Accept all, Reject all and ⌘⏎ act on.
// "Mine vs other" is decided by IChangeOwnersService (never PendingFileOp.ownerThreadId, which goes stale when a chat
// is deleted). A file with no owner, or whose owner chat no longer exists, is "other".
// This file sits directly in sidebar-tsx/ (not chat/) on purpose: it has runtime imports from vs/, and the bundle
// flattens chat/ into this folder, so those relative paths only resolve from here.

import { useCallback } from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import { PendingFileOp } from '../../../../common/pendingFileOps.js';
import { FilePending, reviewScope } from '../../../../common/reviewScope.js';
import { useAccessor, useChangeOwners, useChatThreadsState, useCommandBarState, usePendingFileOps } from '../util/services.js';

export interface ReviewFile extends FilePending {
	readonly uri: URI;
	/** the diff count of the file (pending creates and deletes are in `ops`) */
	readonly diffs: number;
	readonly ops: readonly PendingFileOp[];
	readonly isStreaming: boolean;
}

export interface ThreadReview {
	readonly mine: readonly ReviewFile[];
	readonly others: readonly ReviewFile[];
	/** diffs plus pending creates and deletes in this chat's files */
	readonly changes: number;
	readonly otherFiles: number;
	readonly isStreaming: boolean;
	acceptOrRejectMine(behavior: 'accept' | 'reject'): void;
	acceptOrRejectFile(file: ReviewFile, behavior: 'accept' | 'reject'): void;
	openFile(file: ReviewFile): void;
}

export const useThreadReview = (threadId: string): ThreadReview => {
	const accessor = useAccessor();
	const editCodeService = accessor.get('IEditCodeService');
	const pendingFileOpsService = accessor.get('IPendingFileOpsService');
	const commandService = accessor.get('ICommandService');
	const codeEditorService = accessor.get('ICodeEditorService');
	const changeOwners = useChangeOwners();
	const { allThreads } = useChatThreadsState();
	const { stateOfURI, sortedURIs } = useCommandBarState();
	const pendingFileOps = usePendingFileOps();

	const byKey = new Map<string, { uri: URI; diffs: number; ops: PendingFileOp[]; isStreaming: boolean }>();
	const entry = (uri: URI) => {
		const key = uri.toString();
		let e = byKey.get(key);
		if (!e) {
			e = { uri, diffs: 0, ops: [], isStreaming: false };
			byKey.set(key, e);
		}
		return e;
	};
	for (const uri of sortedURIs) {
		const state = stateOfURI[uri.fsPath];
		const e = entry(uri);
		e.diffs += state?.sortedDiffIds?.length ?? 0;
		e.isStreaming ||= !!state?.isStreaming;
	}
	for (const op of pendingFileOps) {
		entry(URI.parse(op.path)).ops.push(op);
	}

	const files: ReviewFile[] = [];
	for (const [key, e] of byKey) {
		const owner = changeOwners.ownerOf(e.uri);
		files.push({
			path: key,
			owner: owner !== undefined && allThreads[owner] ? owner : undefined,
			changes: e.diffs + e.ops.length,
			uri: e.uri, diffs: e.diffs, ops: e.ops, isStreaming: e.isStreaming,
		});
	}
	const scope = reviewScope(files, threadId);
	const mine = scope.mine;
	const others = files.filter(f => !mine.includes(f));

	const acceptOrRejectFile = (f: ReviewFile, behavior: 'accept' | 'reject') => {
		if (f.isStreaming) {
			return;
		}
		if (f.diffs > 0) {
			editCodeService.acceptOrRejectAllDiffAreas({ uri: f.uri, behavior, removeCtrlKs: false, _addToHistory: true });
		}
		for (const op of f.ops) {
			pendingFileOpsService.resolve(op.id, behavior).catch(e => console.error('Error while resolving a pending file change:', e));
		}
	};
	// Accept all, Reject all and ⌘⏎: this chat's files only, and nothing while one of them is still being written
	const acceptOrRejectMine = (behavior: 'accept' | 'reject') => {
		if (mine.some(f => f.isStreaming)) {
			return;
		}
		for (const f of mine) {
			acceptOrRejectFile(f, behavior);
		}
	};

	// opens the file at its first change (a deleted file or a folder just opens, if it can)
	const openFile = useCallback((file: ReviewFile) => {
		if (file.ops.some(op => op.isFolder)) {
			return;
		}
		const firstDiffId = stateOfURI[file.uri.fsPath]?.sortedDiffIds?.[0];
		const startLine = firstDiffId === undefined ? undefined : editCodeService.diffOfId[firstDiffId]?.startLine;
		commandService.executeCommand('vscode.open', file.uri).then(() => {
			if (startLine === undefined) {
				return;
			}
			setTimeout(() => { // the editor needs a moment when the file was just opened
				const editor = codeEditorService.getActiveCodeEditor();
				if (!editor) {
					return;
				}
				const range = { startLineNumber: startLine, startColumn: 1, endLineNumber: startLine, endColumn: 1 };
				editor.setSelection(range);
				editor.revealLineNearTop(startLine);
			}, 50);
		}, e => console.error('Error while opening a changed file:', e));
	}, [stateOfURI, editCodeService, commandService, codeEditorService]);

	return {
		mine, others,
		changes: scope.changes,
		otherFiles: scope.otherFiles,
		isStreaming: mine.some(f => f.isStreaming),
		acceptOrRejectMine,
		acceptOrRejectFile,
		openFile,
	};
};
