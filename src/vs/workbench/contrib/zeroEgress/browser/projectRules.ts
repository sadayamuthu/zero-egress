/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { isReadableProjectRulesFile } from '../common/projectFiles.js';

export const PROJECT_RULES_FILE = '.zeroegressrules';

/** 'missing' = nothing there; 'unsafe' = a link, a folder or too big; 'ok' = may be read */
export async function checkProjectRulesFile(fileService: IFileService, uri: URI): Promise<'ok' | 'missing' | 'unsafe'> {
	try {
		const s = await fileService.resolve(uri, { resolveMetadata: true });
		return isReadableProjectRulesFile({ isFile: s.isFile, isSymbolicLink: s.isSymbolicLink, size: s.size }) ? 'ok' : 'unsafe';
	} catch {
		return 'missing';
	}
}
