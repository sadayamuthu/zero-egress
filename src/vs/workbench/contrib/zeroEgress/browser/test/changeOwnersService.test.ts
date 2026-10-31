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
import { ChangeOwnersService } from '../changeOwnersService.js';

suite('ChangeOwnersService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let diffZonesChanged: Emitter<{ uri: URI }>;
	let diffAreasOfURI: Record<string, Set<string> | undefined>;
	let pendingFileOps: PendingFileOpsService;
	let service: ChangeOwnersService;

	const a = URI.parse('file:///w/a.ts');

	setup(() => {
		disposables = store.add(new DisposableStore());
		const files = disposables.add(new FileService(new NullLogService()));
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
});
