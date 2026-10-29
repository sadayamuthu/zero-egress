/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runs under test-node by path (it uses no DOM): node test/unit/node/index.js --run <this file>

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditCodeService } from '../editCodeServiceInterface.js';
import { PendingFileOpsService } from '../pendingFileOpsService.js';

suite('PendingFileOpsService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let files: FileService;
	let service: PendingFileOpsService;
	let errors: string[];

	const f = (path: string) => URI.file(path);
	const write = (uri: URI, text: string) => files.writeFile(uri, VSBuffer.fromString(text));

	setup(() => {
		disposables = store.add(new DisposableStore());
		files = disposables.add(new FileService(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		disposables.add(files.registerProvider('vscode-remote', disposables.add(new InMemoryFileSystemProvider())));
		errors = [];
		const models = { getModels: () => [] } as unknown as IModelService;
		const editCode = { acceptOrRejectAllDiffAreas: () => { } } as unknown as IEditCodeService;
		const notifications = { error: (m: string) => { errors.push(String(m)); } } as unknown as INotificationService;
		service = disposables.add(new PendingFileOpsService(files, models, editCode, notifications));
	});

	test('creating a folder that already exists is refused, so rejecting can never remove it', async () => {
		await files.createFolder(f('/w/src'));
		await write(f('/w/src/keep.ts'), 'mine');
		await assert.rejects(() => service.create(f('/w/src'), true), /already exists/);
		assert.strictEqual(service.ops.length, 0);
		await service.resolveAll('reject');
		assert.ok(await files.exists(f('/w/src/keep.ts')));
	});

	test('creating over a pending delete keeps the original and clears the delete', async () => {
		await write(f('/w/a.ts'), 'original');
		await service.markDeleted(f('/w/a.ts'), false);
		await service.create(f('/w/a.ts'), false);
		assert.strictEqual(service.ops.length, 0);
		assert.strictEqual((await files.readFile(f('/w/a.ts'))).value.toString(), 'original');
	});

	test('deleting a path that does not exist is refused', async () => {
		await assert.rejects(() => service.markDeleted(f('/w/missing.ts'), false), /does not exist/);
		assert.strictEqual(service.ops.length, 0);
	});

	test('deleting a non-empty folder without recursive is refused', async () => {
		await write(f('/w/d/a.ts'), 'x');
		await assert.rejects(() => service.markDeleted(f('/w/d'), false), /not empty/);
		await service.markDeleted(f('/w/d'), true);
		assert.deepStrictEqual([service.ops[0].isFolder, service.ops[0].recursive], [true, true]);
	});

	test('a delete that fails on disk stays pending and is reported', async () => {
		await write(f('/w/a.ts'), 'x');
		await service.markDeleted(f('/w/a.ts'), false);
		const del = files.del.bind(files);
		files.del = async () => { throw new Error('disk says no'); };
		await assert.rejects(() => service.resolveAll('accept'));
		files.del = del;
		assert.strictEqual(service.ops.length, 1);
		assert.ok(await files.exists(f('/w/a.ts')));
		assert.strictEqual(errors.length, 1);
		assert.ok(/disk says no/.test(errors[0]), errors[0]);
	});

	test('remote files are created and removed on their own file system', async () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/w/new.ts' });
		await write(f('/w/new.ts'), 'local file with the same path');
		await service.create(remote, false);
		assert.ok(await files.exists(remote));
		await service.resolveAll('reject');
		assert.ok(!(await files.exists(remote)));
		assert.ok(await files.exists(f('/w/new.ts')));
	});
});
