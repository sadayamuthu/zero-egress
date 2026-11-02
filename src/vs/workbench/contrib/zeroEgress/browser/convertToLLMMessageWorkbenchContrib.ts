/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { checkProjectRulesFile, PROJECT_RULES_FILE } from './projectRules.js';
import { IZeroEgressModelService } from '../common/zeroEgressModelService.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.convertcontrib'
	_serviceBrand: undefined;

	constructor(
		@IZeroEgressModelService private readonly zeroEgressModelService: IZeroEgressModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super()

		// a link, a folder or a big file is never opened as a model (it would be read into every prompt)
		const initializeURI = async (uri: URI) => {
			const zeroEgressRulesURI = URI.joinPath(uri, PROJECT_RULES_FILE)
			if (await checkProjectRulesFile(this.fileService, zeroEgressRulesURI) !== 'ok') return
			this.zeroEgressModelService.initializeModel(zeroEgressRulesURI)
		}
		// a rules file created or replaced after startup
		this._register(this.fileService.onDidFilesChange(e => {
			for (const w of this.workspaceContext.getWorkspace().folders) {
				if (e.contains(URI.joinPath(w.uri, PROJECT_RULES_FILE))) void initializeURI(w.uri)
			}
		}))

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders((e) => {
			[...e.changed, ...e.added].forEach(w => { initializeURI(w.uri) })
		}))
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri) })
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);
