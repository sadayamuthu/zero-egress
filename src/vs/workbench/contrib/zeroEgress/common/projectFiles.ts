/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which project files the agent may read into its prompt. A repo can ship `.zeroegressrules` as a link to a secret file.

export const PROJECT_RULES_MAX_BYTES = 64 * 1024;

/** a project rules file is read only if it is a plain file (not a symlink) of known size, at most 64 KB */
export function isReadableProjectRulesFile(e: { isFile: boolean; isSymbolicLink: boolean; size: number | undefined }): boolean {
	return e.isFile && !e.isSymbolicLink && e.size !== undefined && e.size <= PROJECT_RULES_MAX_BYTES;
}
