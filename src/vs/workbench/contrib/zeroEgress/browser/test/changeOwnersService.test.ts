/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runs under test-node by path (it uses no DOM): node test/unit/node/index.js --run <this file>

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IEditCodeService } from '../editCodeServiceInterface.js';
import { IPendingFileOpsService, PendingFileOpsService } from '../pendingFileOpsService.js';
import { ChangeOwnersService, OwnershipConflictError } from '../changeOwnersService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

suite('ChangeOwnersService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let diffZonesChanged: Emitter<{ uri: URI }>;
	let files: FileService;
	let diffAreasOfURI: Record<string, Set<string> | undefined>;
	let pendingFileOps: PendingFileOpsService;
	let service: ChangeOwnersService;

	const a = URI.parse('file:///w/a.ts');

	setup(() => {
		disposables = store.add(new DisposableStore());
		files = disposables.add(new FileService(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		diffZonesChanged = disposables.add(new Emitter<{ uri: URI }>());
		diffAreasOfURI = {};

		const editCode = {
			onDidAddOrDeleteDiffZones: diffZonesChanged.event,
			diffAreasOfURI,
			diffAreaOfId: { '1': { type: 'DiffZone' } },
			acceptOrRejectAllDiffAreas: () => { },
		} as unknown as IEditCodeService;

		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stub(IFileService, files);
		instantiation.stub(IModelService, { getModels: () => [] } as unknown as IModelService);
		instantiation.stub(INotificationService, { error: () => { } } as unknown as INotificationService);
		instantiation.stub(IEditCodeService, editCode);
		pendingFileOps = disposables.add(instantiation.createInstance(PendingFileOpsService));
		instantiation.stub(IPendingFileOpsService, pendingFileOps);
		service = disposables.add(instantiation.createInstance(ChangeOwnersService));
	});

	test('claim then conflict', () => {
		assert.deepStrictEqual(service.claim(a, 't1'), { ok: true });
		assert.deepStrictEqual(service.claim(a, 't2'), { ok: false, owner: 't1' });
	});

	test('owner is released when the file has nothing pending', () => {
		service.claim(a, 't1');
		diffAreasOfURI[a.fsPath] = new Set(['1']);
		diffZonesChanged.fire({ uri: a });
		assert.strictEqual(service.ownerOf(a), 't1');
		delete diffAreasOfURI[a.fsPath];
		diffZonesChanged.fire({ uri: a });
		assert.strictEqual(service.ownerOf(a), undefined);
		assert.deepStrictEqual(service.ownedUris('t1'), []);
	});

	test('pending ops keep the owner', async () => {
		service.claim(a, 't1');
		await pendingFileOps.create(a, false, 't1');
		assert.strictEqual(pendingFileOps.ops[0].ownerThreadId, 't1');
		diffZonesChanged.fire({ uri: a });
		assert.strictEqual(service.ownerOf(a), 't1');
		assert.deepStrictEqual(service.ownedUris('t1').map(u => u.toString()), [a.toString()]);
	});

	const conflictWith = (owner: string, uri: URI) => (e: unknown) =>
		e instanceof OwnershipConflictError && e.owner === owner && e.uri.toString() === uri.toString();

	test('another chat cannot write a path while a write there is in flight', () => {
		const write = service.beginWrite(a, 't1', 'edit');
		// nothing is pending yet (t1 is still awaiting before its write)
		assert.throws(() => service.beginWrite(a, 't2', 'edit'), conflictWith('t1', a));
		assert.strictEqual(service.ownerOf(a), 't1');
		write.dispose();
	});

	test('a sweep during an in-flight write does not release it', () => {
		const write = service.beginWrite(a, 't1', 'edit');
		diffZonesChanged.fire({ uri: a }); // some other file's event: a has no zones yet
		assert.strictEqual(service.ownerOf(a), 't1');
		diffAreasOfURI[a.fsPath] = new Set(['1']);
		write.dispose();
		assert.strictEqual(service.ownerOf(a), 't1');
	});

	test('a write that leaves nothing pending releases its owner when it ends', () => {
		service.beginWrite(a, 't1', 'edit').dispose();
		assert.strictEqual(service.ownerOf(a), undefined);
		service.beginWrite(a, 't2', 'edit').dispose(); // and the next chat gets no conflict
	});

	test('a folder delete or create conflicts with another chat\'s pending changes inside it', () => {
		const inner = URI.parse('file:///w/d/x.ts');
		service.beginWrite(inner, 't1', 'edit').dispose();
		assert.strictEqual(service.ownerOf(inner), undefined);
		const write = service.beginWrite(inner, 't1', 'edit');
		diffAreasOfURI[inner.fsPath] = new Set(['1']);
		write.dispose();
		const folder = URI.parse('file:///w/d');
		assert.throws(() => service.beginWrite(folder, 't2', 'delete'), conflictWith('t1', inner));
		assert.throws(() => service.beginWrite(folder, 't2', 'create'), conflictWith('t1', inner));
		assert.strictEqual(service.ownerOf(folder), undefined);
		service.beginWrite(folder, 't1', 'delete').dispose(); // its own changes are no conflict
	});

	test('a path under another chat\'s pending folder delete conflicts', async () => {
		const folder = URI.parse('file:///w/d');
		const inner = URI.parse('file:///w/d/x.ts');
		await files.writeFile(inner, VSBuffer.fromString('x'));
		const write = service.beginWrite(folder, 't1', 'delete');
		assert.throws(() => service.beginWrite(inner, 't2', 'edit'), conflictWith('t1', folder)); // in flight
		await pendingFileOps.markDeleted(folder, true, 't1');
		write.dispose();
		assert.strictEqual(service.ownerOf(folder), 't1');
		assert.throws(() => service.beginWrite(inner, 't2', 'edit'), conflictWith('t1', folder)); // pending
		service.beginWrite(inner, 't1', 'edit').dispose();
	});
	test('conflictFor reports the other chat without claiming anything', () => {
		const write = service.beginWrite(a, 't1', 'edit');
		diffAreasOfURI[a.fsPath] = new Set(['1']);
		write.dispose();
		assert.deepStrictEqual(service.conflictFor(a, 't2'), { owner: 't1' });
		assert.strictEqual(service.conflictFor(a, 't1'), undefined);
		assert.strictEqual(service.ownerOf(a), 't1');
		assert.deepStrictEqual(service.ownedUris('t2'), []);
		const b = URI.parse('file:///w/b.ts');
		assert.strictEqual(service.conflictFor(b, 't2'), undefined);
		assert.strictEqual(service.ownerOf(b), undefined); // the check claims nothing
	});

	test('changesBlocking selects only the conflicting chat\'s changes at, under or above the path', async () => {
		const folder = URI.parse('file:///w/d');
		const inner = URI.parse('file:///w/d/x.ts');
		const other = URI.parse('file:///w/d/y.ts');
		await files.writeFile(inner, VSBuffer.fromString('x'));
		// t1: pending edit inside d, and pending delete of d; t3: pending edit of an unrelated file
		const w1 = service.beginWrite(inner, 't1', 'edit');
		diffAreasOfURI[inner.fsPath] = new Set(['1']);
		w1.dispose();
		const w3 = service.beginWrite(a, 't3', 'edit');
		diffAreasOfURI[a.fsPath] = new Set(['1']);
		w3.dispose();
		const w2 = service.beginWrite(folder, 't1', 'delete');
		await pendingFileOps.markDeleted(folder, true, 't1');
		w2.dispose();
		const deleteOp = pendingFileOps.ops.find(o => o.kind === 'delete')!;

		// a file under t1's folder delete: the delete above it (by id), and no owned files at or under it
		const forOther = service.changesBlocking(other, 't2');
		assert.deepStrictEqual(forOther && { owner: forOther.owner, uris: forOther.uris.map(u => u.toString()), opIds: forOther.opIds },
			{ owner: 't1', uris: [], opIds: [deleteOp.id] });

		// the folder itself: t1's owned paths at or under it; its own delete is at the path, so no op above it
		const forFolder = service.changesBlocking(folder, 't2');
		assert.deepStrictEqual(forFolder && { owner: forFolder.owner, uris: forFolder.uris.map(u => u.toString()).sort(), opIds: forFolder.opIds },
			{ owner: 't1', uris: [folder.toString(), inner.toString()], opIds: [] });

		assert.strictEqual(service.changesBlocking(a, 't3'), undefined); // its own changes
		assert.strictEqual(service.changesBlocking(URI.parse('file:///w/c.ts'), 't2'), undefined);
	});
});
