/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { GIT_CONFIG_ARGS, gitEnv, WorktreeMainService } from '../worktreeMainService.js';

suite('WorktreeMainService', function () {
	this.timeout(30000);

	let tmp: string;
	let userData: string;
	let service: WorktreeMainService;

	const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

	const makeRepo = (name: string): string => {
		const repo = path.join(tmp, name);
		fs.mkdirSync(repo, { recursive: true });
		git(repo, 'init', '-q');
		git(repo, 'config', 'user.name', 'Test');
		git(repo, 'config', 'user.email', 'test@localhost');
		write(path.join(repo, 'a.txt'), 'a\n');
		write(path.join(repo, 'b.txt'), 'b\n');
		write(path.join(repo, 'pkg', 'inside.txt'), 'inside\n');
		write(path.join(repo, '.gitignore'), '*.log\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'init');
		return repo;
	};

	/** sets the mtime two days back, past prune's 24h guard */
	const age = (p: string) => { const t = new Date(Date.now() - 48 * 3600 * 1000); fs.utimesSync(p, t, t); };

	setup(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ze-worktree-')));
		userData = path.join(tmp, 'userData');
		fs.mkdirSync(userData);
		service = new WorktreeMainService({ userDataPath: userData } as IEnvironmentMainService);
	});

	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('repoInfo of a subfolder', async () => {
		const repo = makeRepo('repo');
		assert.deepStrictEqual(await service.repoInfo(path.join(repo, 'pkg')), { repoRoot: repo, subdir: 'pkg' });
		assert.deepStrictEqual(await service.repoInfo(repo), { repoRoot: repo, subdir: '' });
		const plain = path.join(tmp, 'plain');
		fs.mkdirSync(plain);
		assert.strictEqual(await service.repoInfo(plain), null);
	});

	test('create copies uncommitted changes', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'a.txt'), 'a changed\n');
		fs.rmSync(path.join(repo, 'b.txt'));
		write(path.join(repo, 'new dir', 'nested', 'new file é.txt'), 'new\n');
		write(path.join(repo, 'ignored.log'), 'ignored\n');

		const created = await service.create(repo, 'abcd1234');
		assert.strictEqual(created.branch, 'ze/agent-abcd1234');
		assert.strictEqual(created.worktreePath, path.join(userData, 'agent-worktrees', 'abcd1234'));
		const wt = created.worktreePath;
		assert.strictEqual(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'a changed\n');
		assert.strictEqual(fs.existsSync(path.join(wt, 'b.txt')), false);
		assert.strictEqual(fs.readFileSync(path.join(wt, 'new dir', 'nested', 'new file é.txt'), 'utf8'), 'new\n');
		assert.strictEqual(fs.existsSync(path.join(wt, 'ignored.log')), false);
		assert.strictEqual(git(wt, 'log', '-1', '--format=%s'), 'ze: base');
		assert.strictEqual(git(wt, 'rev-parse', 'HEAD'), created.baseCommit);
		assert.strictEqual(git(wt, 'status', '--porcelain'), '');
		// the user's repo is untouched
		assert.deepStrictEqual(execFileSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean).sort(), [' D b.txt', ' M a.txt', '?? new dir/nested/new file é.txt']);
	});

	test('create runs no hooks', async () => {
		const repo = makeRepo('repo');
		const marker = path.join(tmp, 'hook-ran');
		const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
		write(hook, `#!/bin/sh\ntouch "${marker}"\n`);
		fs.chmodSync(hook, 0o755);
		const commitHook = path.join(repo, '.git', 'hooks', 'pre-commit');
		write(commitHook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
		fs.chmodSync(commitHook, 0o755);

		const clean = await service.create(repo, 'aaaa0001');
		assert.strictEqual(git(clean.worktreePath, 'log', '-1', '--format=%s'), 'ze: base');
		assert.strictEqual(fs.existsSync(marker), false);
	});

	test('changedFiles reports A/M/D under subdir only', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'pkg', 'gone.txt'), 'gone\n');
		write(path.join(repo, 'pkg', 'image.bin'), Buffer.from([0, 1, 2, 3]));
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'more');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'bbbb0001');

		write(path.join(wt, 'pkg', 'inside.txt'), 'inside changed\n');
		write(path.join(wt, 'pkg', 'sub dir', 'añadido.txt'), 'added\n');
		fs.rmSync(path.join(wt, 'pkg', 'gone.txt'));
		write(path.join(wt, 'pkg', 'image.bin'), Buffer.from([0, 9, 9, 9]));
		write(path.join(wt, 'pkg', 'debug.log'), 'ignored\n');
		write(path.join(wt, 'a.txt'), 'outside\n');

		const sort = (files: { path: string }[]) => [...files].sort((x, y) => x.path.localeCompare(y.path));
		assert.deepStrictEqual(sort(await service.changedFiles(wt, baseCommit, 'pkg')), [
			{ path: 'pkg/gone.txt', status: 'D', binary: false },
			{ path: 'pkg/image.bin', status: 'M', binary: true },
			{ path: 'pkg/inside.txt', status: 'M', binary: false },
			{ path: 'pkg/sub dir/añadido.txt', status: 'A', binary: false },
		]);
		assert.deepStrictEqual((await service.changedFiles(wt, baseCommit, '')).map(f => f.path).sort(), ['a.txt', 'pkg/gone.txt', 'pkg/image.bin', 'pkg/inside.txt', 'pkg/sub dir/añadido.txt']);
	});

	test('readBase prefers writeBase overrides', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'cccc0001');
		write(path.join(wt, 'a.txt'), 'agent\n');
		assert.strictEqual(await service.readBase('cccc0001', wt, baseCommit, 'a.txt'), 'a\n');
		assert.strictEqual(await service.readBase('cccc0001', wt, baseCommit, 'missing.txt'), null);
		await service.writeBase('cccc0001', 'a.txt', 'X');
		assert.strictEqual(await service.readBase('cccc0001', wt, baseCommit, 'a.txt'), 'X');
		await service.writeBase('cccc0001', 'a.txt', null);
		assert.strictEqual(await service.readBase('cccc0001', wt, baseCommit, 'a.txt'), null);
		assert.strictEqual(await service.readBase('cccc0001', wt, baseCommit, 'b.txt'), 'b\n');
	});

	test('resolveBinary accept hides the file until it changes again', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2]));
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'img');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'dddd0001');

		write(path.join(wt, 'img.bin'), Buffer.from([0, 7, 7]));
		write(path.join(wt, 'new.bin'), Buffer.from([0, 5]));
		const binaries = async () => (await service.changedFiles(wt, baseCommit, '')).map(f => f.path).sort();
		assert.deepStrictEqual(await binaries(), ['img.bin', 'new.bin']);

		await service.resolveBinary('dddd0001', wt, baseCommit, 'img.bin', 'accept');
		assert.deepStrictEqual(await binaries(), ['new.bin']);

		write(path.join(wt, 'img.bin'), Buffer.from([0, 8, 8]));
		assert.deepStrictEqual(await binaries(), ['img.bin', 'new.bin']);

		fs.rmSync(path.join(wt, 'new.bin'));
		fs.rmSync(path.join(wt, 'img.bin'));
		await service.resolveBinary('dddd0001', wt, baseCommit, 'img.bin', 'accept');
		assert.deepStrictEqual(await binaries(), []);
	});

	test('resolveBinary reject restores the base bytes', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 255]));
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'img');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'eeee0001');

		write(path.join(wt, 'img.bin'), Buffer.from([0, 7, 7]));
		write(path.join(wt, 'new dir', 'new.bin'), Buffer.from([0, 5]));
		await service.resolveBinary('eeee0001', wt, baseCommit, 'img.bin', 'reject');
		await service.resolveBinary('eeee0001', wt, baseCommit, 'new dir/new.bin', 'reject');

		assert.deepStrictEqual([...fs.readFileSync(path.join(wt, 'img.bin'))], [0, 1, 2, 255]);
		assert.strictEqual(fs.existsSync(path.join(wt, 'new dir', 'new.bin')), false);
		assert.deepStrictEqual(await service.changedFiles(wt, baseCommit, ''), []);
	});

	test('rejects paths outside the worktree and non-owned worktrees', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'abab0001');
		const victim = path.join(tmp, 'victim.txt');
		write(victim, 'keep\n');
		const escape = path.relative(wt, victim);
		assert.ok(escape.startsWith('..'));

		await assert.rejects(service.resolveBinary('abab0001', wt, baseCommit, escape, 'reject'));
		await assert.rejects(service.resolveBinary('abab0001', wt, baseCommit, '../x', 'reject'));
		await assert.rejects(service.resolveBinary('abab0001', wt, baseCommit, victim, 'reject'));
		await assert.rejects(service.resolveBinary('abab0001', wt, baseCommit, 'a\\b', 'reject'));
		assert.ok(fs.existsSync(victim));
		await assert.rejects(service.readBase('abab0001', wt, baseCommit, '../a.txt'));
		await assert.rejects(service.writeBase('abab0001', 'pkg/../../a.txt', 'X'));
		await assert.rejects(service.readBase('abab0002', wt, baseCommit, 'a.txt'));

		write(path.join(repo, 'untracked.txt'), 'u\n');
		await assert.rejects(service.changedFiles(repo, baseCommit, ''));
		assert.strictEqual(git(repo, 'diff', '--cached', '--name-only'), '');
		await assert.rejects(service.changedFiles(wt, baseCommit, '../pkg'));
	});

	test('rejects a baseCommit that is not a commit id', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt } = await service.create(repo, 'acac0001');
		const out = path.join(tmp, 'x');
		const bad = `--output=${out}`;
		await assert.rejects(service.changedFiles(wt, bad, ''));
		await assert.rejects(service.readBase('acac0001', wt, bad, 'a.txt'));
		await assert.rejects(service.resolveBinary('acac0001', wt, bad, 'a.txt', 'reject'));
		await assert.rejects(service.changedFiles(wt, 'HEAD', ''));
		assert.strictEqual(fs.existsSync(out), false);
	});

	test('remove deletes worktree, branch and base overrides', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt } = await service.create(repo, 'ffff0001');
		await service.writeBase('ffff0001', 'a.txt', 'X');
		const baseJson = path.join(userData, 'agent-worktrees', 'ffff0001.base.json');
		assert.ok(fs.existsSync(baseJson));

		await service.remove(repo, 'ffff0001');
		assert.strictEqual(fs.existsSync(wt), false);
		assert.strictEqual(fs.existsSync(baseJson), false);
		assert.strictEqual(git(repo, 'branch', '--list', 'ze/agent-ffff0001'), '');
		assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('ffff0001'));

		// already gone: worktree dir deleted by hand, branch missing
		const second = await service.create(repo, 'ffff0002');
		fs.rmSync(second.worktreePath, { recursive: true, force: true });
		await service.remove(repo, 'ffff0002');
		await service.remove(repo, 'ffff0002');
		assert.strictEqual(git(repo, 'branch', '--list', 'ze/agent-ffff0002'), '');
		assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('ffff0002'));
	});

	test('prune keeps listed ids only', async () => {
		const repo = makeRepo('repo');
		const other = makeRepo('other');
		const keep = await service.create(repo, '11110001');
		const drop = await service.create(repo, '11110002');
		const foreign = await service.create(other, '22220001');
		await service.writeBase('11110002', 'a.txt', 'X');
		age(drop.worktreePath);
		age(path.join(userData, 'agent-worktrees', '11110002.base.json'));

		await service.prune(repo, ['11110001']);
		assert.ok(fs.existsSync(keep.worktreePath));
		assert.strictEqual(fs.existsSync(drop.worktreePath), false);
		assert.strictEqual(fs.existsSync(path.join(userData, 'agent-worktrees', '11110002.base.json')), false);
		assert.ok(fs.existsSync(foreign.worktreePath));
		assert.strictEqual(git(repo, 'branch', '--list', 'ze/agent-*', '--format=%(refname:short)'), 'ze/agent-11110001');
		assert.strictEqual(git(other, 'branch', '--list', 'ze/agent-*', '--format=%(refname:short)'), 'ze/agent-22220001');
	});

	test('userFileMatchesBase compares the user file with the base bytes', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2]));
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'img');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'a1a10001');
		const user = (rel: string) => path.join(repo, rel);

		write(path.join(wt, 'img.bin'), Buffer.from([0, 7, 7]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'img.bin', user('img.bin')), true);
		write(user('img.bin'), Buffer.from([0, 9, 9]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'img.bin', user('img.bin')), false);
		fs.rmSync(user('img.bin'));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'img.bin', user('img.bin')), false);

		// absent at base: the user's file must not exist
		write(path.join(wt, 'new.bin'), Buffer.from([0, 5]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'new.bin', user('new.bin')), true);
		write(user('new.bin'), Buffer.from([0, 6]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'new.bin', user('new.bin')), false);

		// after an accept, the accepted bytes are the base
		fs.copyFileSync(path.join(wt, 'new.bin'), user('new.bin'));
		await service.resolveBinary('a1a10001', wt, baseCommit, 'new.bin', 'accept');
		write(path.join(wt, 'new.bin'), Buffer.from([0, 5, 5]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'new.bin', user('new.bin')), true);
		write(user('new.bin'), Buffer.from([1]));
		assert.strictEqual(await service.userFileMatchesBase('a1a10001', wt, baseCommit, 'new.bin', user('new.bin')), false);

		await assert.rejects(service.userFileMatchesBase('a1a10001', wt, baseCommit, '../x', user('x')));
		await assert.rejects(service.userFileMatchesBase('a1a10001', wt, baseCommit, 'img.bin', 'relative/img.bin'));
		await assert.rejects(service.userFileMatchesBase('a1a10002', wt, baseCommit, 'img.bin', user('img.bin')));
		await assert.rejects(service.userFileMatchesBase('a1a10001', wt, 'HEAD', 'img.bin', user('img.bin')));
	});

	test('changedFiles treats text that is not UTF-8 as binary, on either side', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'latin.txt'), Buffer.from('caf\xe9\n', 'latin1'));
		write(path.join(repo, 'plain.txt'), 'plain\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'latin');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'a2a20001');

		write(path.join(wt, 'latin.txt'), Buffer.from('caf\xe9 au lait\n', 'latin1'));
		write(path.join(wt, 'plain.txt'), Buffer.from('pl\xe4in\n', 'latin1'));
		write(path.join(wt, 'a.txt'), 'still utf-8 \u00e9\n');
		const sort = (files: { path: string }[]) => [...files].sort((x, y) => x.path.localeCompare(y.path));
		assert.deepStrictEqual(sort(await service.changedFiles(wt, baseCommit, '')), [
			{ path: 'a.txt', status: 'M', binary: false },
			{ path: 'latin.txt', status: 'M', binary: true },
			{ path: 'plain.txt', status: 'M', binary: true },
		]);
	});

	test('readBase strips a UTF-8 BOM', async () => {
		const repo = makeRepo('repo');
		write(path.join(repo, 'bom.txt'), '\ufeffbom\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'bom');
		const { worktreePath: wt, baseCommit } = await service.create(repo, 'a3a30001');
		assert.strictEqual(await service.readBase('a3a30001', wt, baseCommit, 'bom.txt'), 'bom\n');
	});

	test('prune keeps young or dirty orphans and removes old clean ones', async () => {
		const repo = makeRepo('repo');
		const young = await service.create(repo, '33330001');
		const old = await service.create(repo, '33330002');
		const dirty = await service.create(repo, '33330003');
		await service.writeBase('33330002', 'a.txt', 'X');
		write(path.join(dirty.worktreePath, 'a.txt'), 'dirty\n');
		age(old.worktreePath);
		age(path.join(userData, 'agent-worktrees', '33330002.base.json'));
		age(dirty.worktreePath);

		await service.prune(repo, []);
		assert.ok(fs.existsSync(young.worktreePath), 'young kept');
		assert.ok(fs.existsSync(dirty.worktreePath), 'dirty kept');
		assert.strictEqual(fs.existsSync(old.worktreePath), false, 'old clean removed');
		assert.strictEqual(fs.existsSync(path.join(userData, 'agent-worktrees', '33330002.base.json')), false);
		assert.deepStrictEqual(git(repo, 'branch', '--list', 'ze/agent-*', '--format=%(refname:short)').split('\n').sort(), ['ze/agent-33330001', 'ze/agent-33330003']);
	});

	test('prune keeps an old worktree whose base file is young', async () => {
		const repo = makeRepo('repo');
		const wt = await service.create(repo, '33340001');
		age(wt.worktreePath);
		await service.writeBase('33340001', 'a.txt', 'X');
		await service.prune(repo, []);
		assert.ok(fs.existsSync(wt.worktreePath));
	});

	test('changedFiles refuses a worktree whose .git file is gone or redirected', async () => {
		// the folder above the worktrees is itself a repo: without a ceiling git would find it
		git(tmp, 'init', '-q');
		const repo = makeRepo('repo');
		const gone = await service.create(repo, '44440001');
		fs.rmSync(path.join(gone.worktreePath, '.git'));
		write(path.join(gone.worktreePath, 'x.txt'), 'x\n');
		await assert.rejects(service.changedFiles(gone.worktreePath, gone.baseCommit, ''));
		assert.strictEqual(git(tmp, 'diff', '--cached', '--name-only'), '');

		const moved = await service.create(repo, '44440002');
		write(path.join(moved.worktreePath, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
		write(path.join(moved.worktreePath, 'y.txt'), 'y\n');
		await assert.rejects(service.changedFiles(moved.worktreePath, moved.baseCommit, ''));
		assert.strictEqual(git(repo, 'diff', '--cached', '--name-only'), '');
		assert.strictEqual(git(repo, 'status', '--porcelain'), '');
	});

	test('checkAgentPath follows symlinks', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt } = await service.create(repo, '55550001');
		const outside = path.join(tmp, 'outside');
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(wt, 'pkg', 'link'));
		fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(wt, 'pkg', 'file-link.txt'));

		await service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg', 'inside.txt'));
		await service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg', 'new', 'deeper', 'file.txt'));
		await service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg'));
		await assert.rejects(service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg', 'link', 'x.txt')), /Path is outside this agent's worktree: /);
		await assert.rejects(service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg', 'link')), /Path is outside this agent's worktree: /);
		await assert.rejects(service.checkAgentPath(wt, 'pkg', path.join(wt, 'pkg', 'file-link.txt')), /Path is outside this agent's worktree: /);
		await assert.rejects(service.checkAgentPath(wt, 'pkg', path.join(wt, 'a.txt')), /Path is outside this agent's worktree: /);
		await assert.rejects(service.checkAgentPath(repo, '', path.join(repo, 'a.txt')));
	});

	test('runSetup only runs inside an agent worktree', async () => {
		const repo = makeRepo('repo');
		const { worktreePath: wt } = await service.create(repo, '66660001');
		assert.strictEqual((await service.runSetup(path.join(wt, 'pkg'), 'echo hi', 10000)).exitCode, 0);
		assert.strictEqual((await service.runSetup(wt, 'echo hi', 10000)).exitCode, 0);
		const marker = path.join(tmp, 'ran');
		await assert.rejects(service.runSetup(repo, `touch "${marker}"`, 10000));
		await assert.rejects(service.runSetup(path.join(wt, '..'), `touch "${marker}"`, 10000));
		await assert.rejects(service.runSetup(path.join(userData, 'agent-worktrees', '66660002'), `touch "${marker}"`, 10000));
		assert.strictEqual(fs.existsSync(marker), false);
	});

	test('git runs with network protocols, LFS smudge and lazy fetch off', async () => {
		const env = gitEnv();
		assert.strictEqual(env.GIT_LFS_SKIP_SMUDGE, '1');
		assert.strictEqual(env.GIT_NO_LAZY_FETCH, '1');
		assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
		assert.ok(GIT_CONFIG_ARGS.join(' ').includes('protocol.allow=never'));
		// a local repo still works with every protocol refused
		const repo = makeRepo('repo');
		const { worktreePath: wt } = await service.create(repo, '77770001');
		assert.strictEqual(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'a\n');
	});
});
