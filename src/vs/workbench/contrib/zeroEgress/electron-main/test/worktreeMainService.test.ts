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
import { WorktreeMainService } from '../worktreeMainService.js';

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

		await service.prune(repo, ['11110001']);
		assert.ok(fs.existsSync(keep.worktreePath));
		assert.strictEqual(fs.existsSync(drop.worktreePath), false);
		assert.strictEqual(fs.existsSync(path.join(userData, 'agent-worktrees', '11110002.base.json')), false);
		assert.ok(fs.existsSync(foreign.worktreePath));
		assert.strictEqual(git(repo, 'branch', '--list', 'ze/agent-*', '--format=%(refname:short)'), 'ze/agent-11110001');
		assert.strictEqual(git(other, 'branch', '--list', 'ze/agent-*', '--format=%(refname:short)'), 'ze/agent-22220001');
	});
});
