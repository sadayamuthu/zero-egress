/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ChangedFile, CreatedWorktree, IZeroEgressWorktreeService, RepoInfo } from '../common/worktreeTypes.js';

const MAX_BUFFER = 64 * 1024 * 1024;
const OUTPUT_TAIL = 4000;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
/** prune never removes a worktree touched more recently than this: another window may still be setting it up or using it */
const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Git environment without variables that would redirect it to another repo or index, and with everything that could reach
 * the network off: LFS smudge (`worktree add`, `checkout`) and partial-clone lazy fetches. `ceiling` stops repo discovery
 * at that folder, so a worktree whose `.git` is gone never falls back to a repo above it.
 */
export function gitEnv(ceiling?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) {
			env[key] = value;
		}
	}
	env.GIT_TERMINAL_PROMPT = '0';
	env.GIT_LFS_SKIP_SMUDGE = '1';
	env.GIT_NO_LAZY_FETCH = '1';
	if (ceiling) {
		env.GIT_CEILING_DIRECTORIES = ceiling;
	}
	return env;
}

/** No hooks, no fsmonitor daemon, and no transport at all (`protocol.allow=never` refuses every protocol, `file` included). */
export const GIT_CONFIG_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];

/** Runs a local git subcommand without a shell, with hooks and network transports disabled. */
function git(cwd: string, args: string[], input?: Buffer, ceiling?: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', [...GIT_CONFIG_ARGS, ...args], { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: gitEnv(ceiling) }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`git ${args[0]} failed: ${stderr.toString().trim() || error.message}`));
			} else {
				resolve(stdout);
			}
		});
		child.stdin?.end(input);
	});
}

async function gitText(cwd: string, args: string[], ceiling?: string): Promise<string> {
	return (await git(cwd, args, undefined, ceiling)).toString('utf8');
}

const isUtf8 = (bytes: Uint8Array): boolean => {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};

const stripBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** NUL-separated output, without the trailing empty entry. */
function splitZ(output: Buffer | string): string[] {
	const parts = output.toString().split('\0');
	if (parts[parts.length - 1] === '') {
		parts.pop();
	}
	return parts;
}

const literal = (p: string) => `:(top,literal)${p}`;

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A full commit id; anything else (refs, `--options`) is refused so git can't parse it as an option. */
function checkCommit(baseCommit: string): void {
	if (typeof baseCommit !== 'string' || !COMMIT_ID.test(baseCommit)) {
		throw new Error(`Invalid base commit: ${baseCommit}`);
	}
}

/** A repo-relative `/` path that stays inside the worktree: not absolute, no `..` segment, no backslash. */
function checkRelative(file: string, allowEmpty = false): void {
	const ok = typeof file === 'string'
		&& (allowEmpty || file.length > 0)
		&& !file.includes('\\')
		&& !file.includes('\0')
		&& !path.posix.isAbsolute(file)
		&& !path.win32.isAbsolute(file)
		&& !file.split('/').includes('..');
	if (!ok) {
		throw new Error(`Path is outside this agent's worktree: ${file}`);
	}
}

const hashBytes = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Same id git would give the blob; used only to tell whether a binary file changed. `null` when it does not exist. */
async function blobHash(file: string): Promise<string | null> {
	let stat;
	try {
		stat = await fs.lstat(file);
	} catch {
		return null;
	}
	try {
		return hashBytes(stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file));
	} catch {
		return 'unreadable'; // exists (a folder, say) but matches no blob
	}
}

async function mtimeMs(file: string): Promise<number | undefined> {
	try {
		return (await fs.stat(file)).mtimeMs;
	} catch {
		return undefined;
	}
}

async function samePath(a: string, b: string): Promise<boolean> {
	const real = async (p: string) => { try { return await fs.realpath(p); } catch { return path.resolve(p); } };
	return (await real(a)) === (await real(b));
}

interface BaseState {
	/** `writeBase` overrides: path -> base text, or null when the file does not exist at base. */
	overrides: { [path: string]: string | null };
	/** Accepted binary files: path -> blob hash at accept time, or null when accepted as deleted. */
	binaryAccepted: { [path: string]: string | null };
}

export class WorktreeMainService implements IZeroEgressWorktreeService {
	readonly _serviceBrand: undefined;

	private readonly baseQueues = new Map<string, Promise<unknown>>();

	constructor(@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService) { }

	private get root(): string {
		return path.join(this.environmentMainService.userDataPath, 'agent-worktrees');
	}

	private worktreeOf(agentId: string): string {
		if (!AGENT_ID.test(agentId)) {
			throw new Error(`Invalid agent id: ${agentId}`);
		}
		return path.join(this.root, agentId);
	}

	/** `worktreePath` must be one of ours: `<root>/<agentId>`, and that agent's when `agentId` is given. */
	private checkWorktree(worktreePath: string, agentId?: string): void {
		const resolved = typeof worktreePath === 'string' ? path.resolve(worktreePath) : '';
		const ok = path.dirname(resolved) === path.resolve(this.root)
			&& AGENT_ID.test(path.basename(resolved))
			&& (agentId === undefined || resolved === path.resolve(this.worktreeOf(agentId)));
		if (!ok) {
			throw new Error(`Not an agent worktree: ${worktreePath}`);
		}
	}

	/** Absolute path of `file` inside the worktree, after checking it cannot escape. */
	private inWorktree(worktreePath: string, file: string): string {
		checkRelative(file);
		const root = path.resolve(worktreePath);
		const abs = path.resolve(root, file);
		if (!abs.startsWith(root + path.sep)) {
			throw new Error(`Path is outside this agent's worktree: ${file}`);
		}
		return abs;
	}

	/** git in an agent worktree: repo discovery never climbs above `agent-worktrees/` */
	private wtGit(worktreePath: string, args: string[], input?: Buffer): Promise<Buffer> {
		return git(worktreePath, args, input, this.root);
	}

	private async wtGitText(worktreePath: string, args: string[]): Promise<string> {
		return (await this.wtGit(worktreePath, args)).toString('utf8');
	}

	/**
	 * Throws unless git in `worktreePath` really is that linked worktree: its top level is the folder itself, and its git dir
	 * (`<repo>/.git/worktrees/<id>`) points back at it. A `.git` file the agent deleted or redirected fails here.
	 */
	private async verifyWorktree(worktreePath: string): Promise<void> {
		const real = await fs.realpath(worktreePath);
		const [top, gitDir] = (await this.wtGitText(worktreePath, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])).split('\n');
		let backLink = '';
		try {
			backLink = (await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
		} catch {
			// not a linked worktree's git dir
		}
		const realOrEmpty = async (p: string) => { try { return await fs.realpath(p); } catch { return ''; } };
		if (!top || await realOrEmpty(top) !== real || !backLink || await realOrEmpty(path.dirname(backLink)) !== real) {
			throw new Error(`Not an agent worktree: ${worktreePath}`);
		}
	}

	private baseFile(agentId: string): string {
		return `${this.worktreeOf(agentId)}.base.json`;
	}

	async repoInfo(folder: string): Promise<RepoInfo | null> {
		try {
			const [top, prefix] = (await gitText(folder, ['rev-parse', '--show-toplevel', '--show-prefix'])).split('\n');
			if (!top) {
				return null;
			}
			return { repoRoot: path.normalize(top), subdir: (prefix ?? '').replace(/\/$/, '') };
		} catch {
			return null;
		}
	}

	async create(repoRoot: string, agentId: string): Promise<CreatedWorktree> {
		const worktreePath = this.worktreeOf(agentId);
		const branch = `ze/agent-${agentId}`;
		await fs.mkdir(this.root, { recursive: true });
		await git(repoRoot, ['worktree', 'prune']);
		await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
		try {
			// tracked changes, staged or not, including deletions and binary files
			const diff = await git(repoRoot, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/']);
			if (diff.length > 0) {
				await this.wtGit(worktreePath, ['apply', '--binary', '--whitespace=nowarn'], diff);
			}
			// untracked, non-ignored files
			for (const rel of splitZ(await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))) {
				if (rel.endsWith('/')) {
					continue; // a nested repository
				}
				const from = path.join(repoRoot, rel);
				const to = path.join(worktreePath, rel);
				await fs.mkdir(path.dirname(to), { recursive: true });
				const stat = await fs.lstat(from);
				if (stat.isSymbolicLink()) {
					await fs.symlink(await fs.readlink(from), to);
				} else if (stat.isFile()) {
					await fs.copyFile(from, to);
				}
			}
			await this.wtGit(worktreePath, ['add', '-A']);
			await this.wtGit(worktreePath, ['-c', 'user.name=ZeroEgress', '-c', 'user.email=agent@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--no-verify', '-q', '-m', 'ze: base']);
			const baseCommit = (await this.wtGitText(worktreePath, ['rev-parse', 'HEAD'])).trim();
			return { worktreePath, branch, baseCommit };
		} catch (e) {
			await this.remove(repoRoot, agentId).catch(() => { });
			throw e;
		}
	}

	/** `cwd` must be an existing agent worktree or a folder inside one. */
	private async checkAgentRoot(cwd: string): Promise<void> {
		const rel = typeof cwd === 'string' ? path.relative(path.resolve(this.root), path.resolve(cwd)) : '';
		const [id, ...rest] = rel.split(path.sep);
		if (!rel || !id || path.isAbsolute(rel)) {
			throw new Error(`Not an agent worktree: ${cwd}`);
		}
		const worktreePath = path.join(this.root, id);
		this.checkWorktree(worktreePath);
		checkRelative(rest.join('/'), true);
		if (!(await fs.stat(worktreePath).catch(() => undefined))?.isDirectory()) {
			throw new Error(`Not an agent worktree: ${cwd}`);
		}
	}

	async runSetup(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; outputTail: string }> {
		await this.checkAgentRoot(cwd);
		return new Promise(resolve => {
			let tail = '';
			let done = false;
			const append = (chunk: Buffer | string) => { tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL); };
			const finish = (exitCode: number | null) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve({ exitCode, outputTail: tail });
				}
			};
			const isWindows = process.platform === 'win32';
			// a shell by design: this is the user's configured setup command
			const child = spawn(command, { cwd, shell: true, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
			child.stdout?.on('data', append);
			child.stderr?.on('data', append);
			child.on('error', err => { append(`${err.message}\n`); finish(null); });
			child.on('close', code => finish(code));
			const timer = setTimeout(() => {
				append(`\nSetup command timed out after ${timeoutMs} ms.\n`);
				try {
					if (isWindows && child.pid !== undefined) {
						execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { });
					} else if (child.pid !== undefined) {
						process.kill(-child.pid, 'SIGKILL'); // the whole process group
					}
				} catch {
					child.kill('SIGKILL');
				}
				finish(null);
			}, timeoutMs);
		});
	}

	async changedFiles(worktreePath: string, baseCommit: string, subdir: string): Promise<ChangedFile[]> {
		this.checkWorktree(worktreePath);
		checkCommit(baseCommit);
		checkRelative(subdir, true);
		await this.verifyWorktree(worktreePath);
		await this.wtGit(worktreePath, ['add', '-A']);
		const flags = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=all', '-z'];
		const spec = subdir ? ['--', literal(subdir)] : [];
		const nameStatus = splitZ(await this.wtGit(worktreePath, [...flags, '--name-status', baseCommit, ...spec]));
		const numstat = splitZ(await this.wtGit(worktreePath, [...flags, '--numstat', baseCommit, ...spec]));

		const binary = new Set<string>();
		for (const line of numstat) {
			if (line.startsWith('-\t-\t')) {
				binary.add(line.slice(4));
			}
		}

		const { binaryAccepted: accepted, overrides } = await this.readState(path.basename(worktreePath));
		const result: ChangedFile[] = [];
		for (let i = 0; i + 1 < nameStatus.length; i += 2) {
			const code = nameStatus[i][0];
			const file = nameStatus[i + 1];
			// text that is not UTF-8 (latin1, say) is reviewed as binary: decoding it for a line review would corrupt it
			const isBinary = binary.has(file) || !await this.isUtf8Text(worktreePath, baseCommit, file, code, overrides);
			if (isBinary && Object.prototype.hasOwnProperty.call(accepted, file)
				&& accepted[file] === await blobHash(path.join(worktreePath, file))) {
				continue; // accepted as-is and unchanged since
			}
			result.push({ path: file, status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', binary: isBinary });
		}
		return result;
	}

	/** whether the base side (unless overridden, which is always text) and the agent's side of `file` decode as UTF-8 */
	private async isUtf8Text(worktreePath: string, baseCommit: string, file: string, code: string, overrides: BaseState['overrides']): Promise<boolean> {
		if (code !== 'A' && !Object.prototype.hasOwnProperty.call(overrides, file)) {
			if (!isUtf8(await this.wtGit(worktreePath, ['show', `${baseCommit}:${file}`]))) {
				return false;
			}
		}
		if (code !== 'D') {
			try {
				if (!isUtf8(await fs.readFile(this.inWorktree(worktreePath, file)))) {
					return false;
				}
			} catch {
				// a symlink or unreadable file: git's own view stands
			}
		}
		return true;
	}

	async readBase(agentId: string, worktreePath: string, baseCommit: string, file: string): Promise<string | null> {
		this.checkWorktree(worktreePath, agentId);
		checkCommit(baseCommit);
		checkRelative(file);
		const { overrides } = await this.readState(agentId);
		if (Object.prototype.hasOwnProperty.call(overrides, file)) {
			return overrides[file];
		}
		if (!await this.existsAtBase(worktreePath, baseCommit, file)) {
			return null;
		}
		// a BOM is stripped on every side of the review (agentReview.decodeReviewText) and put back on write
		return stripBom(await this.wtGitText(worktreePath, ['show', `${baseCommit}:${file}`]));
	}

	async writeBase(agentId: string, file: string, content: string | null): Promise<void> {
		checkRelative(file);
		return this.updateState(agentId, state => { state.overrides[file] = content; });
	}

	async resolveBinary(agentId: string, worktreePath: string, baseCommit: string, file: string, behavior: 'accept' | 'reject'): Promise<void> {
		this.checkWorktree(worktreePath, agentId);
		checkCommit(baseCommit);
		const abs = this.inWorktree(worktreePath, file);
		if (behavior === 'accept') {
			const hash = await blobHash(abs);
			return this.updateState(agentId, state => { state.binaryAccepted[file] = hash; });
		}
		if (await this.existsAtBase(worktreePath, baseCommit, file)) {
			await this.wtGit(worktreePath, ['checkout', baseCommit, '--', literal(file)]);
		} else {
			await fs.rm(abs, { force: true });
		}
		return this.updateState(agentId, state => { delete state.binaryAccepted[file]; });
	}

	async userFileMatchesBase(agentId: string, worktreePath: string, baseCommit: string, file: string, userFilePath: string): Promise<boolean> {
		this.checkWorktree(worktreePath, agentId);
		checkCommit(baseCommit);
		checkRelative(file);
		if (typeof userFilePath !== 'string' || userFilePath.includes('\0') || !path.isAbsolute(userFilePath)) {
			throw new Error(`Invalid file path: ${userFilePath}`);
		}
		const { binaryAccepted, overrides } = await this.readState(agentId);
		let expected: string | null;
		if (Object.prototype.hasOwnProperty.call(binaryAccepted, file)) {
			expected = binaryAccepted[file];
		} else if (Object.prototype.hasOwnProperty.call(overrides, file)) {
			const text = overrides[file];
			expected = text === null ? null : hashBytes(Buffer.from(text, 'utf8'));
		} else if (await this.existsAtBase(worktreePath, baseCommit, file)) {
			expected = (await this.wtGitText(worktreePath, ['rev-parse', '--verify', '--quiet', `${baseCommit}:${file}`])).trim();
		} else {
			expected = null;
		}
		return await blobHash(userFilePath) === expected;
	}

	async checkAgentPath(worktreePath: string, subdir: string, file: string): Promise<void> {
		this.checkWorktree(worktreePath);
		checkRelative(subdir, true);
		const outside = () => new Error(`Path is outside this agent's worktree: ${file}`);
		if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file)) {
			throw outside();
		}
		const root = await fs.realpath(path.join(worktreePath, subdir));
		// the nearest entry that exists (a dangling symlink counts: realpath then fails and the path is refused)
		let p = path.resolve(file);
		for (; ;) {
			try {
				await fs.lstat(p);
				break;
			} catch {
				const parent = path.dirname(p);
				if (parent === p) {
					throw outside();
				}
				p = parent;
			}
		}
		let real: string;
		try {
			real = await fs.realpath(p);
		} catch {
			throw outside();
		}
		if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
			throw outside();
		}
	}

	async remove(repoRoot: string, agentId: string): Promise<void> {
		const worktreePath = this.worktreeOf(agentId);
		await git(repoRoot, ['worktree', 'remove', '--force', '--force', worktreePath]).catch(() => { });
		await fs.rm(worktreePath, { recursive: true, force: true });
		await git(repoRoot, ['worktree', 'prune']).catch(() => { });
		await git(repoRoot, ['branch', '-D', `ze/agent-${agentId}`]).catch(() => { });
		await this.enqueue(agentId, () => fs.rm(this.baseFile(agentId), { force: true }));
	}

	async prune(repoRoot: string, keepAgentIds: string[]): Promise<void> {
		const keep = new Set(keepAgentIds);
		const drop = new Set<string>();
		await git(repoRoot, ['worktree', 'prune']).catch(() => { });

		// worktrees of this repo under agent-worktrees/
		for (const line of (await gitText(repoRoot, ['worktree', 'list', '--porcelain'])).split('\n')) {
			if (!line.startsWith('worktree ')) {
				continue;
			}
			const wt = line.slice('worktree '.length);
			const id = path.basename(wt);
			if (AGENT_ID.test(id) && !keep.has(id) && await samePath(path.dirname(wt), this.root)) {
				drop.add(id);
			}
		}
		// branches of this repo, even without a worktree
		const branches = await gitText(repoRoot, ['branch', '--list', 'ze/agent-*', '--format=%(refname:short)']);
		for (const branch of branches.split('\n')) {
			const id = branch.trim().slice('ze/agent-'.length);
			if (branch.startsWith('ze/agent-') && AGENT_ID.test(id) && !keep.has(id)) {
				drop.add(id);
			}
		}
		for (const id of drop) {
			// threads storage is last-writer-wins across windows: an id missing from `keep` may be another window's live agent
			if (!await this.isInUse(id)) {
				await this.remove(repoRoot, id);
			}
		}

		// base files whose worktree is gone belong to no live agent
		let entries: string[] = [];
		try { entries = await fs.readdir(this.root); } catch { /* no agents yet */ }
		for (const entry of entries) {
			const id = entry.endsWith('.base.json') ? entry.slice(0, -'.base.json'.length) : undefined;
			if (id && AGENT_ID.test(id) && !keep.has(id) && !entries.includes(id)) {
				await this.enqueue(id, () => fs.rm(this.baseFile(id), { force: true }));
			}
		}
	}

	/** touched in the last 24h (worktree folder or base file), or with uncommitted changes; also when that can't be told */
	private async isInUse(agentId: string): Promise<boolean> {
		const worktreePath = this.worktreeOf(agentId);
		const now = Date.now();
		for (const file of [worktreePath, this.baseFile(agentId)]) {
			const mtime = await mtimeMs(file);
			if (mtime !== undefined && now - mtime < PRUNE_MIN_AGE_MS) {
				return true;
			}
		}
		if (await mtimeMs(worktreePath) === undefined) {
			return false; // only a branch is left
		}
		try {
			await this.verifyWorktree(worktreePath);
			return (await this.wtGitText(worktreePath, ['status', '--porcelain', '-z'])).length > 0;
		} catch {
			return true;
		}
	}

	private async existsAtBase(worktreePath: string, baseCommit: string, file: string): Promise<boolean> {
		try {
			await this.wtGit(worktreePath, ['rev-parse', '--verify', '--quiet', `${baseCommit}:${file}`]);
			return true;
		} catch {
			return false;
		}
	}

	private async readState(agentId: string): Promise<BaseState> {
		const state: BaseState = { overrides: Object.create(null), binaryAccepted: Object.create(null) };
		try {
			const parsed = JSON.parse(await fs.readFile(this.baseFile(agentId), 'utf8'));
			Object.assign(state.overrides, parsed?.overrides);
			Object.assign(state.binaryAccepted, parsed?.binaryAccepted);
		} catch {
			// no overrides yet
		}
		return state;
	}

	private updateState(agentId: string, mutate: (state: BaseState) => void): Promise<void> {
		return this.enqueue(agentId, async () => {
			const state = await this.readState(agentId);
			mutate(state);
			const file = this.baseFile(agentId);
			await fs.mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(state));
			await fs.rename(tmp, file);
		});
	}

	/** Serializes base-file reads-modify-writes per agent. */
	private enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.baseQueues.get(agentId) ?? Promise.resolve();
		const next = previous.catch(() => { }).then(task);
		this.baseQueues.set(agentId, next);
		next.finally(() => { if (this.baseQueues.get(agentId) === next) { this.baseQueues.delete(agentId); } }).catch(() => { });
		return next;
	}
}
