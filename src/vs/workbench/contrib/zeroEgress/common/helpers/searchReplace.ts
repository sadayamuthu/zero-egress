/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure Search/Replace text transform, shared by editCodeService (docked agent, diff zones)
// and toolsService (background agents, straight to disk).

import { tripleTick } from '../prompt/prompts.js'
import { ExtractedSearchReplaceBlock, extractSearchReplaceBlocks } from './extractCodeFromResult.js'

const numLinesOfStr = (str: string) => str.split('\n').length

// Helper function to remove whitespace except newlines
const removeWhitespaceExceptNewlines = (str: string): string => {
	return str.replace(/[^\S\n]+/g, '');
}


// finds block.orig in fileContents and return its range in file
// startingAtLine is 1-indexed and inclusive
// returns 1-indexed lines
export const findTextInCode = (text: string, fileContents: string, canFallbackToRemoveWhitespace: boolean, opts: { startingAtLine?: number, returnType: 'lines' }) => {

	const returnAns = (fileContents: string, idx: number) => {
		const startLine = numLinesOfStr(fileContents.substring(0, idx + 1))
		const numLines = numLinesOfStr(text)
		const endLine = startLine + numLines - 1

		return [startLine, endLine] as const
	}

	const startingAtLineIdx = (fileContents: string) => opts?.startingAtLine !== undefined ?
		fileContents.split('\n').slice(0, opts.startingAtLine).join('\n').length // num characters in all lines before startingAtLine
		: 0

	// idx = starting index in fileContents
	let idx = fileContents.indexOf(text, startingAtLineIdx(fileContents))

	// if idx was found
	if (idx !== -1) {
		return returnAns(fileContents, idx)
	}

	if (!canFallbackToRemoveWhitespace)
		return 'Not found' as const

	// try to find it ignoring all whitespace this time
	text = removeWhitespaceExceptNewlines(text)
	fileContents = removeWhitespaceExceptNewlines(fileContents)
	idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));

	if (idx === -1) return 'Not found' as const
	const lastIdx = fileContents.lastIndexOf(text)
	if (lastIdx !== idx) return 'Not unique' as const

	return returnAns(fileContents, idx)
}


/**
 * Generates a human-readable error message for an invalid ORIGINAL search block.
 */
export const errContentOfInvalidStr = (
	str: 'Not found' | 'Not unique' | 'Has overlap',
	blockOrig: string,
): string => {
	const problematicCode = `${tripleTick[0]}\n${JSON.stringify(blockOrig)}\n${tripleTick[1]}`

	// use a switch for better readability / exhaustiveness check
	let descStr: string
	switch (str) {
		case 'Not found':
			descStr = `The edit was not applied. The text in ORIGINAL must EXACTLY match lines of code in the file, but there was no match for:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code matches a code excerpt exactly.`
			break
		case 'Not unique':
			descStr = `The edit was not applied. The text in ORIGINAL must be unique in the file being edited, but the following ORIGINAL code appears multiple times in the file:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code is unique.`
			break
		case 'Has overlap':
			descStr = `The edit was not applied. The text in the ORIGINAL blocks must not overlap, but the following ORIGINAL code had overlap with another ORIGINAL string:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code blocks do not overlap.`
			break
		default:
			descStr = ''
	}
	return descStr
}


/**
 * Applies a Search/Replace blocks string to `original` (LF line endings) and returns the new text.
 * `original === null` means the file does not exist.
 * Throws with the same messages the LLM has always seen when a block does not match.
 */
export const applySearchReplaceBlocks = (blocksStr: string, original: string | null): string => {
	const blocks = extractSearchReplaceBlocks(blocksStr)
	if (blocks.length === 0) throw new Error(`No Search/Replace blocks were received!`)

	if (original === null) throw new Error(`Error applying Search/Replace blocks: File does not exist.`)
	const modelStr = original
	const modelStrLines = modelStr.split('\n')

	const replacements: { origStart: number; origEnd: number; block: ExtractedSearchReplaceBlock }[] = []
	for (const b of blocks) {
		const res = findTextInCode(b.orig, modelStr, true, { returnType: 'lines' })
		if (typeof res === 'string')
			throw new Error(errContentOfInvalidStr(res, b.orig))
		let [startLine, endLine] = res
		startLine -= 1 // 0-index
		endLine -= 1

		// including newline before start
		const origStart = (startLine !== 0 ?
			modelStrLines.slice(0, startLine).join('\n') + '\n'
			: '').length

		// including endline at end
		const origEnd = modelStrLines.slice(0, endLine + 1).join('\n').length - 1

		replacements.push({ origStart, origEnd, block: b });
	}
	// sort in increasing order
	replacements.sort((a, b) => a.origStart - b.origStart)

	// ensure no overlap
	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i].origStart <= replacements[i - 1].origEnd) {
			throw new Error(errContentOfInvalidStr('Has overlap', replacements[i]?.block?.orig))
		}
	}

	// apply each replacement from right to left (so indexes don't shift)
	let newCode: string = modelStr
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { origStart, origEnd, block } = replacements[i]
		newCode = newCode.slice(0, origStart) + block.final + newCode.slice(origEnd + 1, Infinity)
	}
	return newCode
}
