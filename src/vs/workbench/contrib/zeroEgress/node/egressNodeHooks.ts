/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Node-side egress enforcement, shared by electron-main (EgressGuard) and the extension host (proxyResolver).
// Wraps globalThis.fetch, http/https request+get, and the socket entry points net.connect/createConnection
// and tls.connect, so libraries that bypass the request APIs (bundled undici, ws, raw sockets) are still
// policed by host+port. Unix-socket/pipe connections (`path`/`socketPath`) and TLS over an existing socket
// are local or already policed, and pass. `check(url)` decides; it is responsible for recording blocks.
// Pass the CommonJS module objects (require('http'), ...): patches are mirrored to ESM namespace imports
// via syncBuiltinESMExports, but callers that copied a function reference before install are not covered.

import type * as httpType from 'http';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import { syncBuiltinESMExports } from 'node:module';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { describeDestination } from '../common/egressPolicy.js';

export interface EgressHookTargets {
	readonly global: { fetch: typeof fetch };
	readonly http: typeof httpType;
	readonly https: typeof httpType;
	readonly net: typeof netType;
	readonly tls: typeof tlsType;
}

export function egressBlockedError(url: string): Error {
	return new Error(`ZeroEgress blocked connection to ${describeDestination(url)} (not a configured server)`);
}

function bracket(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function socketUrl(host: string | undefined, port: number | string | undefined): string {
	return `http://${bracket(host || 'localhost')}:${port ?? 0}/`;
}

/** Normalizes http(s).request/get arguments; `url` is undefined for a unix socket. Throws like Node on a bad URL. */
function requestOptions(args: unknown[], defaultPort: number): { url: string | undefined; options: any; callback: unknown } {
	const [a, b, c] = args;
	let options: any;
	let callback: unknown;
	if (typeof a === 'string' || a instanceof URL) {
		const u = new URL(String(a));
		options = { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: `${u.pathname}${u.search}` };
		if (b && typeof b === 'object') { options = { ...options, ...b }; callback = c; } else { callback = b; }
	} else {
		options = { ...(a as object ?? {}) };
		callback = b;
	}
	if (options.socketPath) { return { url: undefined, options, callback }; }
	const port = options.port || options.defaultPort || options.agent?.defaultPort || defaultPort;
	return { url: socketUrl(options.hostname ?? options.host, port), options, callback };
}

/** Destination of net.connect / tls.connect arguments, or undefined when no TCP host is dialled. */
function socketDestination(args: unknown[]): string | undefined {
	const [a, b] = args;
	if (a && typeof a === 'object') {
		const o = a as { path?: string; socket?: unknown; host?: string; port?: number | string };
		if (o.path || o.socket) { return undefined; }
		return socketUrl(o.host, o.port);
	}
	if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
		return socketUrl(typeof b === 'string' ? b : undefined, a);
	}
	return undefined; // (path[, cb]) form: unix socket / named pipe
}

export function installEgressNodeHooks(check: (url: string) => boolean, t: EgressHookTargets): IDisposable {
	const restore: (() => void)[] = [];
	const patch = <O extends object, K extends keyof O>(obj: O, key: K, wrap: (original: O[K]) => O[K]) => {
		const original = obj[key];
		obj[key] = wrap(original);
		restore.push(() => { obj[key] = original; });
	};

	patch(t.global, 'fetch', original => async function (input: string | URL | Request, init?: RequestInit) {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : typeof input?.url === 'string' ? input.url : String(input);
		if (!check(url)) { throw egressBlockedError(url); }
		return original.call(globalThis, input, init);
	} as typeof fetch);

	for (const [mod, defaultPort] of [[t.http, 80], [t.https, 443]] as const) {
		for (const key of ['request', 'get'] as const) {
			patch(mod, key, original => function (this: unknown, ...args: unknown[]) {
				const { url, options, callback } = requestOptions(args, defaultPort);
				if (url === undefined || check(url)) { return (original as Function).apply(this, args); }
				const err = egressBlockedError(url);
				// A real ClientRequest whose connection fails with our error: callers see the normal 'error' event.
				const blocked = { ...options, agent: undefined, createConnection: (_o: unknown, cb: (e: Error) => void) => { cb(err); return undefined; } };
				return (original as Function).call(this, blocked, callback);
			} as typeof original);
		}
	}

	const blockedSocket = (url: string) => {
		const socket = new t.net.Socket();
		process.nextTick(() => socket.destroy(egressBlockedError(url)));
		return socket;
	};
	for (const [mod, key] of [[t.net, 'connect'], [t.net, 'createConnection'], [t.tls, 'connect']] as const) {
		patch(mod as any, key, (original: Function) => function (this: unknown, ...args: unknown[]) {
			const url = socketDestination(args);
			if (url === undefined || check(url)) { return original.apply(this, args); }
			return blockedSocket(url);
		});
	}

	syncBuiltinESMExports();
	return toDisposable(() => {
		while (restore.length) { restore.pop()!(); }
		syncBuiltinESMExports();
	});
}
