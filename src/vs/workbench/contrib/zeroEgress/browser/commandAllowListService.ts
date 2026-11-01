/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Per-workspace allowed terminal commands (StorageScope.WORKSPACE, key zeroEgress.commandAllowList, JSON string[]).

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { canAllowList, isAllowed, normalizeCommand } from '../common/commandAllowList.js';

export interface ICommandAllowListService {
	readonly _serviceBrand: undefined;
	readonly list: readonly string[];
	readonly onDidChange: Event<void>;
	add(cmd: string): void;
	remove(cmd: string): void;
	isAllowed(cmd: string): boolean;
}

export const ICommandAllowListService = createDecorator<ICommandAllowListService>('zeroEgressCommandAllowListService');

const STORAGE_KEY = 'zeroEgress.commandAllowList';

export class CommandAllowListService extends Disposable implements ICommandAllowListService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(@IStorageService private readonly _storageService: IStorageService) {
		super();
	}

	get list(): readonly string[] {
		try {
			const parsed = JSON.parse(this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
			return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
		} catch { return []; }
	}

	private _write(list: readonly string[]) {
		this._storageService.store(STORAGE_KEY, JSON.stringify(list), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	add(cmd: string): void {
		if (!canAllowList(cmd)) { return; }
		const n = normalizeCommand(cmd);
		const cur = this.list;
		if (cur.includes(n)) { return; }
		this._write([...cur, n]);
	}

	remove(cmd: string): void {
		const n = normalizeCommand(cmd);
		const cur = this.list;
		if (!cur.includes(n)) { return; }
		this._write(cur.filter(c => c !== n));
	}

	isAllowed(cmd: string): boolean {
		return isAllowed(this.list, cmd);
	}
}

registerSingleton(ICommandAllowListService, CommandAllowListService, InstantiationType.Delayed);
