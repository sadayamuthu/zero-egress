/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Persistent terminals are owned per thread: a background agent owns the terminals it opened
// (keyed by agentId); the docked agent uses the ones no background agent owns.
// `agentId` undefined means the docked agent.

export type TerminalOwnerOf = (terminalId: string) => string | undefined

export const terminalIdsVisibleTo = (terminalIds: string[], ownerOf: TerminalOwnerOf, agentId: string | undefined): string[] =>
	terminalIds.filter(id => ownerOf(id) === agentId)

export const checkTerminalOwner = (terminalId: string, ownerOf: TerminalOwnerOf, agentId: string | undefined): void => {
	if (ownerOf(terminalId) !== agentId) throw new Error(`Terminal ${terminalId} does not belong to this agent.`)
}
