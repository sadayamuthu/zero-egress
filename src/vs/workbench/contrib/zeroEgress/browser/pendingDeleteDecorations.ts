/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shows a file the agent wants to delete (pending review) in red and struck through in every open editor.

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPendingFileOpsService } from './pendingFileOpsService.js';

class PendingDeleteDecorations extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.pendingDeleteDecorations';

	private readonly _collections = new Map<ICodeEditor, IEditorDecorationsCollection>();
	private readonly _editorListeners = this._register(new DisposableMap<ICodeEditor>());

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IPendingFileOpsService private readonly _pendingFileOpsService: IPendingFileOpsService,
	) {
		super();
		for (const editor of this._codeEditorService.listCodeEditors()) {
			this._track(editor);
		}
		this._register(this._codeEditorService.onCodeEditorAdd(editor => this._track(editor)));
		this._register(this._codeEditorService.onCodeEditorRemove(editor => {
			this._editorListeners.deleteAndDispose(editor);
			this._collections.delete(editor);
		}));
		this._register(this._pendingFileOpsService.onDidChange(() => {
			for (const editor of this._collections.keys()) {
				this._update(editor);
			}
		}));
	}

	private _track(editor: ICodeEditor): void {
		this._collections.set(editor, editor.createDecorationsCollection());
		this._editorListeners.set(editor, editor.onDidChangeModel(() => this._update(editor)));
		this._update(editor);
	}

	private _isPendingDelete(path: string): boolean {
		return this._pendingFileOpsService.ops.some(op => op.kind === 'delete' && (path === op.path || path.startsWith(op.path + '/')));
	}

	private _update(editor: ICodeEditor): void {
		const collection = this._collections.get(editor);
		const model = editor.getModel();
		if (!collection) {
			return;
		}
		if (!model || model.uri.scheme !== 'file' || !this._isPendingDelete(model.uri.fsPath)) {
			collection.clear();
			return;
		}
		collection.set([{
			range: model.getFullModelRange(),
			options: {
				description: 'zeroEgress-pending-delete',
				isWholeLine: true,
				className: 'ze-pending-delete',
				inlineClassName: 'ze-pending-delete-text',
			},
		}]);
	}
}

registerWorkbenchContribution2(PendingDeleteDecorations.ID, PendingDeleteDecorations, WorkbenchPhase.AfterRestored);
