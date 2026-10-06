/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { REVIEW_DESKTOP_CONNECTION_VERSION } from '../common/reviewDesktopBootstrap.js';
import { ReviewExternalServerConnection } from './reviewExternalServerConnection.js';

const origin = 'http://127.0.0.1:47100';

function connectionWith(fetch: typeof globalThis.fetch, overrides: { viewerToken?: string; appVersion?: string; errors?: string[] } = {}) {
	return new ReviewExternalServerConnection({
		appVersion: overrides.appVersion ?? '0.2.0',
		resolveEndpoint: async () => ({ origin, viewerToken: 'viewerToken' in overrides ? overrides.viewerToken : 'viewer-secret' }),
		fetch,
		retryDelays: [0],
		logInfo: () => { },
		logError: (message) => overrides.errors?.push(message),
	});
}

const health = (instanceId: string, extra: Record<string, unknown> = { access: 'viewer' }) =>
	Response.json({ ok: true, instanceId, desktopAttached: true, version: '0.2.0', ...extra });

test('connects as a viewer with the instance the server names', async (t) => {
	const requests: { url: string; token: string | null }[] = [];
	const connection = connectionWith(async (input, init) => {
		requests.push({ url: String(input), token: new Headers(init?.headers).get('x-review-token') });
		return health('instance-1');
	});
	t.after(() => connection.dispose());

	const connected = await connection.whenConnected();

	assert.deepEqual(requests, [{ url: `${origin}/health`, token: 'viewer-secret' }]);
	assert.deepEqual(connected, {
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: origin,
		token: 'viewer-secret',
		instanceId: 'instance-1',
		appSessionId: connection.appSessionId,
		access: 'viewer',
	});
});

test('reads the server again on every call, so a relaunched server is found', async (t) => {
	let instance = 'instance-1';
	const connection = connectionWith(async () => health(instance));
	t.after(() => connection.dispose());

	assert.equal((await connection.whenConnected()).instanceId, 'instance-1');
	instance = 'instance-2';
	assert.equal((await connection.whenConnected()).instanceId, 'instance-2');
});

test('retries while the server cannot be reached', async (t) => {
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		if (calls < 3) throw new TypeError('fetch failed');
		return health('instance-1');
	});
	t.after(() => connection.dispose());

	assert.equal((await connection.whenConnected()).instanceId, 'instance-1');
	assert.equal(calls, 3);
});

test('a server that does not take the token as a viewer is an error, not a retry', async (t) => {
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		return health('instance-1', {});
	});
	t.after(() => connection.dispose());

	await assert.rejects(connection.whenConnected(), /viewer token/i);
	assert.equal(calls, 1);
});

test('a rejecting server on another version names both versions', async (t) => {
	const connection = connectionWith(async () => health('instance-1', { version: '0.1.0' }), { appVersion: '0.2.0' });
	t.after(() => connection.dispose());

	await assert.rejects(connection.whenConnected(), (error: Error) => {
		assert.match(error.message, /viewer token/i);
		assert.match(error.message, /0\.1\.0/);
		assert.match(error.message, /0\.2\.0/);
		return true;
	});
});

test('a rejecting server on the same version blames only the token', async (t) => {
	const connection = connectionWith(async () => health('instance-1', {}));
	t.after(() => connection.dispose());

	await assert.rejects(connection.whenConnected(), (error: Error) => {
		assert.doesNotMatch(error.message, /0\.2\.0/);
		return true;
	});
});

test('an OK answer that is not Whiteboard health is a logged failure', async (t) => {
	const errors: string[] = [];
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		if (calls === 1) return Response.json({ status: 'up' });
		if (calls === 2) return new Response('<html>tailnet</html>', { status: 200 });
		return health('instance-1');
	}, { errors });
	t.after(() => connection.dispose());

	assert.equal((await connection.whenConnected()).instanceId, 'instance-1');
	assert.equal(calls, 3);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /not a Whiteboard server/i);
});

test('without a viewer token it asks for one before reaching out', async (t) => {
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		return health('instance-1');
	}, { viewerToken: undefined });
	t.after(() => connection.dispose());

	await assert.rejects(connection.whenConnected(), /review\.server\.viewerToken|WHITEBOARD_VIEWER_TOKEN/);
	assert.equal(calls, 0);
});

test('logs a version difference and connects anyway', async (t) => {
	const errors: string[] = [];
	const connection = connectionWith(async () => health('instance-1'), { appVersion: '0.3.0', errors });
	t.after(() => connection.dispose());

	await connection.whenConnected();

	assert.match(errors.join('\n'), /0\.2\.0.*0\.3\.0|0\.3\.0.*0\.2\.0/);
});

test('stopping ends a pending connection', async (t) => {
	const connection = connectionWith(async () => {
		throw new TypeError('fetch failed');
	});
	t.after(() => connection.dispose());

	const pending = connection.whenConnected();
	await connection.stop();

	await assert.rejects(pending, /stopped/i);
});

test('a non-OK answer is retried, and the first failure is logged once', async (t) => {
	const errors: string[] = [];
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		if (calls < 3) return new Response('bad gateway', { status: 502 });
		return health('instance-1');
	}, { errors });
	t.after(() => connection.dispose());

	assert.equal((await connection.whenConnected()).instanceId, 'instance-1');
	assert.equal(errors.length, 1);
	assert.match(errors[0], /502/);
});

test('retrying leaves no abort listeners behind', async (t) => {
	let calls = 0;
	const connection = connectionWith(async () => {
		calls += 1;
		if (calls < 6) throw new TypeError('fetch failed');
		return health('instance-1');
	});
	t.after(() => connection.dispose());

	await connection.whenConnected();

	const signal = (connection as unknown as { stopped: AbortController }).stopped.signal;
	assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('stopping during an in-flight request rejects promptly and logs nothing', async (t) => {
	const errors: string[] = [];
	const connection = new ReviewExternalServerConnection({
		appVersion: '0.2.0',
		resolveEndpoint: async () => ({ origin, viewerToken: 'viewer-secret' }),
		fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
		}),
		retryDelays: [60_000],
		logInfo: () => { },
		logError: (message) => errors.push(message),
	});
	t.after(() => connection.dispose());

	const pending = connection.whenConnected();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await connection.stop();

	await assert.rejects(pending, /stopped/i);
	assert.deepEqual(errors, []);
});
