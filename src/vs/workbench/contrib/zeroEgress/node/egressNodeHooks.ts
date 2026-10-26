/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Node-side egress enforcement, shared by electron-main (EgressGuard), the extension host (proxyResolver)
// and the shared process. `check(url)` decides and is responsible for recording a block.
//
// Enforcement point: net.Socket.prototype.connect. Every TCP connection in Node reaches it: net.connect,
// net.createConnection (including the reference http.Agent captured at startup), tls.connect (TLSSocket
// extends Socket), new http.ClientRequest, undici/fetch, ws, and `new net.Socket().connect()`. Unix
// sockets and pipes (`path`) pass. tls.connect({ socket }) wraps a socket that already went through here.
// A host allowed only for being a loopback *name* (localhost, *.localhost) must also resolve to an allowed
// address, so a custom `lookup` cannot map it elsewhere.
//
// globalThis.fetch and http/https request/get are wrapped too, only so callers get a clean error (and one
// log line) before any socket exists; a blocked request is built as a bare ClientRequest that never dials,
// so proxy-agent's patched request (which may attach its own agent) is never involved.
// Optionally also wraps Electron's `net.request` / `net.fetch` (used by the shared process).
// Pass the CommonJS module objects (require('http'), ...); patches are mirrored to ESM namespace imports.

import type * as httpType from 'http';
import type * as netType from 'net';
import * as dns from 'dns';
import { isIP } from 'net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { describeDestination, isAllowed, isLoopbackHost } from '../common/egressPolicy.js';

export interface EgressHookTargets {
	readonly global: { fetch: typeof fetch };
	readonly http: typeof httpType;
	readonly https: typeof httpType;
	readonly net: typeof netType;
	/** Electron's `net` module, where its requests do not go through a session's webRequest filter. */
	readonly electronNet?: { request: Function; fetch?: Function };
}

export function egressBlockedError(url: string): Error {
	return new Error(`ZeroEgress blocked connection to ${describeDestination(url)} (not a configured server)`);
}

function bracket(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function socketUrl(host: string | undefined, port: number | string | undefined): string {
	return `http://${bracket(host || 'localhost')}:${port || 0}/`;
}

function fetchInputUrl(input: unknown): string {
	return typeof input === 'string' ? input : input instanceof URL ? input.href : typeof (input as Request)?.url === 'string' ? (input as Request).url : String(input);
}

/** Normalizes http(s).request/get arguments the way Node does; `url` is undefined for a unix socket. */
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
	return { url: socketUrl(options.hostname || options.host, port), options, callback };
}

/** Socket#connect arguments as [options, connectListener]; also accepts Node's internal pre-normalized array. */
function connectArgs(args: unknown[]): [{ path?: string; host?: string; port?: number | string; lookup?: Function }, unknown] {
	const [a, b, c] = args;
	if (Array.isArray(a)) { return [a[0] ?? {}, a[1]]; }
	if (a && typeof a === 'object') { return [a, b]; }
	if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
		return typeof b === 'string' ? [{ port: a, host: b }, c] : [{ port: a }, b];
	}
	return [{ path: String(a) }, b]; // (path[, cb]): unix socket / named pipe
}

function electronRequestUrl(options: any): string {
	if (typeof options === 'string') { return options; }
	if (typeof options?.url === 'string') { return options.url; }
	const protocol = options?.protocol || 'http:';
	const authority = options?.hostname ? `${bracket(options.hostname)}${options.port ? `:${options.port}` : ''}` : (options?.host || 'localhost');
	return `${protocol}//${authority}/`;
}

export function installEgressNodeHooks(check: (url: string) => boolean, t: EgressHookTargets): IDisposable {
	const restore: (() => void)[] = [];
	const patch = <O extends object, K extends keyof O>(obj: O, key: K, wrap: (original: O[K]) => O[K]) => {
		const original = obj[key];
		obj[key] = wrap(original);
		restore.push(() => { obj[key] = original; });
	};

	// The choke point.
	patch(t.net.Socket.prototype, 'connect', original => function (this: netType.Socket, ...args: unknown[]) {
		const [options, listener] = connectArgs(args);
		if (options.path) { return (original as Function).apply(this, args); }
		const host = options.host || 'localhost';
		const url = socketUrl(host, options.port);
		if (!check(url)) {
			// Look like a connect in progress (as the real connect does synchronously) so early writes are
			// buffered rather than failing with 'Socket is closed'; then fail with our error. setImmediate, not
			// nextTick: an http ClientRequest attaches its socket 'error' listener on a later tick.
			(this as { connecting: boolean }).connecting = true;
			setImmediate(() => this.destroy(egressBlockedError(url)));
			return this;
		}
		if (!isIP(host.replace(/^\[|\]$/g, '')) && isLoopbackHost(host)) {
			const lookup = (options.lookup ?? dns.lookup) as Function;
			const guardedLookup = (hostname: string, opts: any, cb?: Function) => {
				if (typeof opts === 'function') { cb = opts; opts = {}; }
				lookup(hostname, opts, (err: Error | null, address: string | dns.LookupAddress[], family?: number) => {
					if (err) { return cb!(err, address, family); }
					const addresses = Array.isArray(address) ? address.map(a => a.address) : [address];
					const denied = addresses.map(a => socketUrl(a, options.port)).find(u => !check(u));
					return denied ? cb!(egressBlockedError(denied)) : cb!(err, address, family);
				});
			};
			return (original as Function).call(this, { ...options, lookup: guardedLookup }, listener);
		}
		return (original as Function).apply(this, args);
	} as typeof original);

	patch(t.global, 'fetch', original => async function (input: string | URL | Request, init?: RequestInit) {
		const url = fetchInputUrl(input);
		if (!check(url)) { throw egressBlockedError(url); }
		return original.call(globalThis, input, init);
	} as typeof fetch);

	for (const [mod, defaultPort] of [[t.http, 80], [t.https, 443]] as const) {
		for (const key of ['request', 'get'] as const) {
			patch(mod, key, original => function (this: unknown, ...args: unknown[]) {
				const { url, options, callback } = requestOptions(args, defaultPort);
				if (url === undefined || check(url)) { return (original as Function).apply(this, args); }
				const err = egressBlockedError(url);
				// A bare ClientRequest whose connection fails with our error: callers see the normal 'error' event.
				const req = new t.http.ClientRequest({
					...options,
					agent: undefined,
					_defaultAgent: mod.globalAgent,
					createConnection: (_o: unknown, cb: (e: Error) => void) => { cb(err); return undefined; },
				} as httpType.ClientRequestArgs, callback as (res: httpType.IncomingMessage) => void);
				if (key === 'get') { req.end(); }
				return req;
			} as typeof original);
		}
	}

	const electronNet = t.electronNet;
	if (electronNet && !Object.isFrozen(electronNet)) {
		patch(electronNet, 'request', original => function (this: unknown, options: unknown, ...rest: unknown[]) {
			const url = electronRequestUrl(options);
			if (!check(url)) { throw egressBlockedError(url); }
			return original.call(this, options, ...rest);
		});
		if (typeof electronNet.fetch === 'function') {
			patch(electronNet, 'fetch', original => async function (this: unknown, input: unknown, ...rest: unknown[]) {
				const url = fetchInputUrl(input);
				if (!check(url)) { throw egressBlockedError(url); }
				return original!.call(this, input, ...rest);
			});
		}
	}

	syncBuiltinESMExports();
	return toDisposable(() => {
		while (restore.length) { restore.pop()!(); }
		syncBuiltinESMExports();
	});
}

/**
 * For processes that never need more than loopback (the shared process): installs the hooks on this
 * process's own modules with an empty allow-list, plus Electron `net` when given. `onBlocked` records.
 */
export function installLoopbackOnlyEgressHooks(onBlocked: (url: string) => void, electronNet?: EgressHookTargets['electronNet']): IDisposable {
	const require = createRequire(import.meta.url);
	const check = (url: string) => {
		if (isAllowed(url, [])) { return true; }
		onBlocked(url);
		return false;
	};
	return installEgressNodeHooks(check, { global: globalThis, http: require('http'), https: require('https'), net: require('net'), electronNet });
}
