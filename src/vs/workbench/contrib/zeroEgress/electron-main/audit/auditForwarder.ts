/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { AuditRecord } from '../../common/auditTypes.js';

export interface IAuditForwarder {
	send(records: AuditRecord[]): Promise<{ ok: boolean }>;
}

export class HttpAuditForwarder implements IAuditForwarder {
	constructor(private readonly opts: { endpointUrl: string; authHeader: string; timeoutMs?: number }) { }

	send(records: AuditRecord[]): Promise<{ ok: boolean }> {
		return new Promise((resolve) => {
			let parsed: URL;
			try { parsed = new URL(this.opts.endpointUrl); }
			catch { resolve({ ok: false }); return; }

			const payload = records.map(r => JSON.stringify(r)).join('\n');
			const headers: Record<string, string> = {
				'Content-Type': 'application/x-ndjson',
				'Content-Length': Buffer.byteLength(payload).toString(),
			};
			// authHeader is a raw "Name: value" line; split once on the first colon.
			const idx = this.opts.authHeader.indexOf(':');
			if (idx > 0) headers[this.opts.authHeader.slice(0, idx).trim()] = this.opts.authHeader.slice(idx + 1).trim();

			const lib = parsed.protocol === 'https:' ? https : http;
			try {
				const req = lib.request(
					{ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'POST', headers },
					(res) => {
						res.resume(); // drain
						const code = res.statusCode ?? 0;
						resolve({ ok: code >= 200 && code < 300 });
					});
				req.on('error', () => resolve({ ok: false }));
				// Bound each request so a collector that accepts but never responds can't leave a hung socket.
				// req.destroy() may fire 'error' on some Node versions — resolve is idempotent, so that's fine.
				req.setTimeout(this.opts.timeoutMs ?? 10000, () => { req.destroy(); resolve({ ok: false }); });
				req.write(payload);
				req.end();
			} catch {
				resolve({ ok: false });
			}
		});
	}
}
