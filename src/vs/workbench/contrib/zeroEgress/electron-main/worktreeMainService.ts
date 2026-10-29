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

/** Git environment without variables that would redirect it to another repo or index. */
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) {
			env[key] = value;
		}
	}
	env.GIT_TERMINAL_PROMPT = '0';
	return env;
}

/** Runs a local git subcommand without a shell and with hooks disabled. */
function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: gitEnv() }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`git ${args[0]} failed: ${stderr.toString().trim() || error.message}`));
			} else {
				resolve(stdout);
			}
		});
		child.stdin?.end(input);
	});
}

async function gitText(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args)).toString('utf8');
}

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

/** Same id git would give the blob; used only to tell whether a binary file changed since it was accepted. */
async function blobHash(file: string): Promise<string | null> {
	try {
		const stat = await fs.lstat(file);
		const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
		return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
	} catch {
		return null;
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
				await git(worktreePath, ['apply', '--binary', '--whitespace=nowarn'], diff);
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
			await git(worktreePath, ['add', '-A']);
			await git(worktreePath, ['-c', 'user.name=ZeroEgress', '-c', 'user.email=agent@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--no-verify', '-q', '-m', 'ze: base']);
			const baseCommit = (await gitText(worktreePath, ['rev-parse', 'HEAD'])).trim();
			return { worktreePath, branch, baseCommit };
		} catch (e) {
			await this.remove(repoRoot, agentId).catch(() => { });
			throw e;
		}
	}

	runSetup(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; outputTail: string }> {
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
		await git(worktreePath, ['add', '-A']);
		const flags = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=all', '-z'];
		const spec = subdir ? ['--', literal(subdir)] : [];
		const nameStatus = splitZ(await git(worktreePath, [...flags, '--name-status', baseCommit, ...spec]));
		const numstat = splitZ(await git(worktreePath, [...flags, '--numstat', baseCommit, ...spec]));

		const binary = new Set<string>();
		for (const line of numstat) {
			if (line.startsWith('-\t-\t')) {
				binary.add(line.slice(4));
			}
		}

		const accepted = (await this.readState(path.basename(worktreePath))).binaryAccepted;
		const result: ChangedFile[] = [];
		for (let i = 0; i + 1 < nameStatus.length; i += 2) {
			const code = nameStatus[i][0];
			const file = nameStatus[i + 1];
			const isBinary = binary.has(file);
			if (isBinary && Object.prototype.hasOwnProperty.call(accepted, file)
				&& accepted[file] === await blobHash(path.join(worktreePath, file))) {
				continue; // accepted as-is and unchanged since
			}
			result.push({ path: file, status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', binary: isBinary });
		}
		return result;
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
		return gitText(worktreePath, ['show', `${baseCommit}:${file}`]);
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
			await git(worktreePath, ['checkout', baseCommit, '--', literal(file)]);
		} else {
			await fs.rm(abs, { force: true });
		}
		return this.updateState(agentId, state => { delete state.binaryAccepted[file]; });
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
			await this.remove(repoRoot, id);
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

	private async existsAtBase(worktreePath: string, baseCommit: string, file: string): Promise<boolean> {
		try {
			await git(worktreePath, ['rev-parse', '--verify', '--quiet', `${baseCommit}:${file}`]);
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
