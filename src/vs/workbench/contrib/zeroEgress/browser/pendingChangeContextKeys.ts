/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Context keys that scope the review shortcuts (⌘Y/⌘N per change, ⌥⌘Y/⌥⌘N per file), so VS Code's own
// bindings for those keys keep working everywhere else.

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { diffAtLine } from '../common/diffAtLine.js';
import { Diff } from '../common/editCodeServiceTypes.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IPendingFileOpsService } from './pendingFileOpsService.js';

export const CURSOR_ON_PENDING_CHANGE = new RawContextKey<boolean>('zeroEgress.cursorOnPendingChange', false);
export const FILE_HAS_PENDING_CHANGES = new RawContextKey<boolean>('zeroEgress.fileHasPendingChanges', false);

/** The pending (not yet accepted or rejected) diffs in a file. */
export function pendingDiffsOf(editCodeService: IEditCodeService, uri: URI): Diff[] {
	const areaIds = editCodeService.diffAreasOfURI[uri.fsPath];
	if (!areaIds?.size) {
		return [];
	}
	return Object.values(editCodeService.diffOfId).filter(d => areaIds.has(String(d.diffareaid)));
}

class PendingChangeContextKeys extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.pendingChangeContextKeys';

	private readonly _cursorOnChange: IContextKey<boolean>;
	private readonly _fileHasChanges: IContextKey<boolean>;
	private readonly _editorListener = this._register(new MutableDisposable());

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService editorService: IEditorService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@IPendingFileOpsService private readonly _pendingFileOpsService: IPendingFileOpsService,
	) {
		super();
		this._cursorOnChange = CURSOR_ON_PENDING_CHANGE.bindTo(contextKeyService);
		this._fileHasChanges = FILE_HAS_PENDING_CHANGES.bindTo(contextKeyService);

		this._register(editorService.onDidActiveEditorChange(() => this._watchActiveEditor()));
		this._register(this._editCodeService.onDidAddOrDeleteDiffZones(() => this._update()));
		this._register(this._editCodeService.onDidChangeDiffsInDiffZoneNotStreaming(() => this._update()));
		this._register(this._pendingFileOpsService.onDidChange(() => this._update()));
		this._watchActiveEditor();
	}

	private _activeEditor(): ICodeEditor | null {
		return this._codeEditorService.getActiveCodeEditor();
	}

	private _watchActiveEditor(): void {
		const editor = this._activeEditor();
		this._editorListener.value = editor?.onDidChangeCursorPosition(() => this._update());
		this._update();
	}

	private _update(): void {
		const editor = this._activeEditor();
		const model = editor?.getModel();
		if (!editor || !model) {
			this._cursorOnChange.set(false);
			this._fileHasChanges.set(false);
			return;
		}
		const diffs = pendingDiffsOf(this._editCodeService, model.uri);
		const line = editor.getPosition()?.lineNumber;
		const hasFileOp = this._pendingFileOpsService.ops.some(op => model.uri.fsPath === op.path || model.uri.fsPath.startsWith(op.path + '/'));
		this._cursorOnChange.set(line !== undefined && !!diffAtLine(diffs, line));
		this._fileHasChanges.set(diffs.length > 0 || hasFileOp);
	}
}

registerWorkbenchContribution2(PendingChangeContextKeys.ID, PendingChangeContextKeys, WorkbenchPhase.AfterRestored);
