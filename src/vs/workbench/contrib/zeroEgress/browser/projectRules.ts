/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ProjectRulesState, projectRulesStateOf } from '../common/projectFiles.js';

export const PROJECT_RULES_FILE = '.zeroegressrules';

/** 'missing' = nothing there; 'link' = a symlink; 'unsafe' = a folder, too big, or it couldn't be checked; 'ok' = may be read */
export async function checkProjectRulesFile(fileService: IFileService, uri: URI): Promise<ProjectRulesState> {
	try {
		const s = await fileService.resolve(uri, { resolveMetadata: true });
		return projectRulesStateOf({ isFile: s.isFile, isSymbolicLink: s.isSymbolicLink, size: s.size });
	} catch (e) {
		// only "not found" is missing: any other error (permissions, a broken link) is never read
		return e instanceof Error && toFileOperationResult(e) === FileOperationResult.FILE_NOT_FOUND ? 'missing' : 'unsafe';
	}
}
