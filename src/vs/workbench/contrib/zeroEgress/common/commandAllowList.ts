/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Allowed terminal commands: exact match after whitespace normalizing; anything with shell control syntax never matches.

export function normalizeCommand(cmd: string): string {
	return cmd.trim().replace(/\s+/g, ' ');
}

export function canAllowList(cmd: string): boolean {
	if (/[;&|`<>\n\r]|\$\(/.test(cmd)) { return false; }
	return normalizeCommand(cmd).length > 0;
}

export function isAllowed(list: readonly string[], cmd: string): boolean {
	return canAllowList(cmd) && list.includes(normalizeCommand(cmd));
}

export type TerminalAutoRun = 'off' | 'allowList' | 'all';

export function terminalAutoRunOf(s: { autoApprove: { terminal?: boolean }; useCommandAllowList: boolean }): TerminalAutoRun {
	if (s.autoApprove.terminal) { return 'all'; }
	return s.useCommandAllowList ? 'allowList' : 'off';
}

export function settingsForTerminalAutoRun(v: TerminalAutoRun): { terminal: boolean; useCommandAllowList: boolean } {
	return { terminal: v === 'all', useCommandAllowList: v === 'allowList' };
}
