/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReviewServerSettings, reviewExternalServerOrigin } from './reviewServerSettings.js';

test('with nothing set, the Desktop embeds its server on a port the OS picks, with no viewer', () => {
	assert.deepEqual(resolveReviewServerSettings({}, {}), {
		mode: 'embedded',
		host: '127.0.0.1',
		port: 0,
		viewerToken: undefined,
	});
});

test('the environment overrides the port and viewer token settings', () => {
	const settings = resolveReviewServerSettings(
		{ mode: 'external', host: 'client1.example', port: 47100, viewerToken: 'from-settings' },
		{ WHITEBOARD_SERVER_PORT: '47200', WHITEBOARD_VIEWER_TOKEN: 'from-env' },
	);

	assert.deepEqual(settings, { mode: 'external', host: 'client1.example', port: 47200, viewerToken: 'from-env' });
});

test('blank values count as unset', () => {
	const settings = resolveReviewServerSettings(
		{ host: '  ', port: 47100, viewerToken: '  ' },
		{ WHITEBOARD_SERVER_PORT: ' ', WHITEBOARD_VIEWER_TOKEN: '' },
	);

	assert.equal(settings.host, '127.0.0.1');
	assert.equal(settings.port, 47100);
	assert.equal(settings.viewerToken, undefined);
});

test('an unknown mode falls back to embedded', () => {
	assert.equal(resolveReviewServerSettings({ mode: 'remote' }, {}).mode, 'embedded');
});

test('a port outside 0-65535 names where it came from', () => {
	assert.throws(() => resolveReviewServerSettings({}, { WHITEBOARD_SERVER_PORT: '70000' }), /WHITEBOARD_SERVER_PORT.*70000/);
	assert.throws(() => resolveReviewServerSettings({ port: -1 }, {}), /review\.server\.port.*-1/);
	assert.throws(() => resolveReviewServerSettings({}, { WHITEBOARD_SERVER_PORT: 'abc' }), /WHITEBOARD_SERVER_PORT.*abc/);
});

test('a loopback host is reached over http, any other over https', () => {
	assert.equal(reviewExternalServerOrigin('127.0.0.1', 47100), 'http://127.0.0.1:47100');
	assert.equal(reviewExternalServerOrigin('localhost', 47100), 'http://127.0.0.1:47100');
	assert.equal(reviewExternalServerOrigin('client1.example', 443), 'https://client1.example');
	assert.equal(reviewExternalServerOrigin('client1.example', 8443), 'https://client1.example:8443');
});

test('an external server needs a real port and a plain host name', () => {
	assert.throws(() => reviewExternalServerOrigin('127.0.0.1', 0), /review\.server\.port/);
	assert.throws(() => reviewExternalServerOrigin('http://client1.example', 443), /review\.server\.host/);
});
