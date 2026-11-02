/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util'
import { exec as _exec, execFile as _execFile, spawn } from 'child_process'
import { IZeroEgressSCMService } from '../common/zeroEgressSCMTypes.js'
import { realpath } from 'fs/promises'
import { join } from 'path'
import { DIFF_MAX_CHARS, appendCapped, isValidBranchName } from '../common/selectionText.js'
import { isInsideRoot, noIndexDiffOk, parseNulList } from '../common/gitUntracked.js'

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

// no external diff drivers or textconv filters (repo config could run programs through them)
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']
const GIT_DIFF_TIMEOUT_MS = 15_000
const UNTRACKED_LIST_MAX_CHARS = 1_000_000

type GitRun = { text: string; truncated: boolean; timedOut: boolean; code: number | null; stderr: string }

/** runs git with an args array (never a shell string); stops reading and kills git at `max` chars or at `deadline` */
const runGit = (args: string[], cwd: string, max: number, deadline: number): Promise<GitRun> => new Promise((resolve, reject) => {
	const remaining = deadline - Date.now()
	if (remaining <= 0) { resolve({ text: '', truncated: true, timedOut: true, code: null, stderr: '' }); return }
	const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
	let text = ''
	let stderr = ''
	let truncated = false
	let timedOut = false
	const timer = setTimeout(() => { timedOut = true; truncated = true; child.kill() }, remaining)
	child.stdout.setEncoding('utf8')
	child.stderr.setEncoding('utf8')
	child.stdout.on('data', (chunk: string) => {
		if (truncated) { return }
		const r = appendCapped(text, chunk, max)
		text = r.text
		if (r.full) { truncated = true; child.kill() }
	})
	child.stderr.on('data', (chunk: string) => { if (stderr.length < 4000) { stderr += chunk } })
	child.on('error', e => { clearTimeout(timer); reject(e) })
	child.on('close', code => { clearTimeout(timer); resolve({ text, truncated, timedOut, code, stderr }) })
})

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
		const deadline = Date.now() + GIT_DIFF_TIMEOUT_MS
		const diff = await runGit(['diff', ...DIFF_FLAGS, against ?? 'HEAD', '--'], path, DIFF_MAX_CHARS, deadline)
		if (!diff.truncated && diff.code !== 0) { throw new Error(diff.stderr.trim().split('\n')[0] || `git exited with code ${diff.code}`) }
		let text = diff.text
		if (against !== null || diff.truncated) { return { text, truncated: diff.truncated } }

		// working changes also cover new files git doesn't track yet (ignored files stay out)
		const list = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], path, UNTRACKED_LIST_MAX_CHARS, deadline)
		if (list.timedOut) { return { text, truncated: true } }
		if (!list.truncated && list.code !== 0) { return { text, truncated: false } }
		let realRoot: string
		try { realRoot = await realpath(path) } catch { return { text, truncated: false } }
		for (const file of parseNulList(list.text, !list.truncated)) {
			if (text.length >= DIFF_MAX_CHARS) { return { text, truncated: true } }
			// never read past the repo, also not through a link
			if (!isInsideRoot(path, file)) { continue }
			try { if (!isInsideRoot(realRoot, await realpath(join(path, file)))) { continue } } catch { continue }
			const r = await runGit(['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], path, DIFF_MAX_CHARS - text.length, deadline)
			if (r.truncated) { return { text: text + r.text, truncated: true } }
			if (!noIndexDiffOk(r.code)) { continue }
			text += r.text
		}
		return { text, truncated: false }
	}

	async gitBranches(path: string): Promise<string[]> {
		const { stdout } = await execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: path, maxBuffer: 10 * 1024 * 1024 })
		return stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
	}
}
