/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util'
import { exec as _exec, execFile as _execFile, spawn } from 'child_process'
import { IZeroEgressSCMService } from '../common/zeroEgressSCMTypes.js'
import { DIFF_MAX_CHARS, appendCapped, isValidBranchName } from '../common/selectionText.js'

interface NumStat {
	file: string
	added: number
	removed: number
}

const exec = promisify(_exec)
const execFile = promisify(_execFile)

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000
const MAX_DIFF_FILES = 10

const git = async (command: string, path: string): Promise<string> => {
	const { stdout, stderr } = await exec(`${command}`, { cwd: path })
	if (stderr) {
		throw new Error(stderr)
	}
	return stdout.trim()
}

const getNumStat = async (path: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	const staged = useStagedChanges ? '--staged' : ''
	const output = await git(`git diff --numstat ${staged}`, path)
	return output
		.split('\n')
		.map((line) => {
			const [added, removed, file] = line.split('\t')
			return {
				file,
				added: parseInt(added, 10) || 0,
				removed: parseInt(removed, 10) || 0,
			}
		})
}

const getSampledDiff = async (file: string, path: string, useStagedChanges: boolean): Promise<string> => {
	const staged = useStagedChanges ? '--staged' : ''
	const diff = await git(`git diff --unified=0 --no-color ${staged} -- "${file}"`, path)
	return diff.slice(0, MAX_DIFF_LENGTH)
}

const hasStagedChanges = async (path: string): Promise<boolean> => {
	const output = await git('git diff --staged --name-only', path)
	return output.length > 0
}

export class ZeroEgressSCMService implements IZeroEgressSCMService {
	readonly _serviceBrand: undefined

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const staged = useStagedChanges ? '--staged' : ''
		return git(`git diff --stat ${staged}`, path)
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const numStatList = await getNumStat(path, useStagedChanges)
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES)
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })))
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n')
	}

	gitBranch(path: string): Promise<string> {
		return git('git branch --show-current', path)
	}

	gitLog(path: string): Promise<string> {
		return git('git log --pretty=format:"%h|%s|%ad" --date=short --no-merges -n 5', path)
	}

	async gitDiff(path: string, against: string | null): Promise<{ text: string; truncated: boolean }> {
		if (against !== null && !isValidBranchName(against)) { throw new Error('Not a valid branch name.') }
		// args array, never a shell string; stop reading and kill git once the cap is reached
		return new Promise((resolve, reject) => {
			const child = spawn('git', ['diff', '--no-color', against ?? 'HEAD', '--'], { cwd: path })
			let text = ''
			let stderr = ''
			let truncated = false
			child.stdout.setEncoding('utf8')
			child.stderr.setEncoding('utf8')
			child.stdout.on('data', (chunk: string) => {
				if (truncated) { return }
				const r = appendCapped(text, chunk, DIFF_MAX_CHARS)
				text = r.text
				if (r.full) { truncated = true; child.kill() }
			})
			child.stderr.on('data', (chunk: string) => { if (stderr.length < 4000) { stderr += chunk } })
			child.on('error', e => reject(e))
			child.on('close', code => {
				if (truncated || code === 0) { resolve({ text, truncated }) }
				else { reject(new Error(stderr.trim().split('\n')[0] || `git exited with code ${code}`)) }
			})
		})
	}

	async gitBranches(path: string): Promise<string[]> {
		const { stdout } = await execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: path, maxBuffer: 10 * 1024 * 1024 })
		return stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
	}
}
