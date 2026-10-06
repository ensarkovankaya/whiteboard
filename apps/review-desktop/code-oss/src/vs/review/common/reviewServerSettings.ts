/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { REVIEW_SERVER_MODES, REVIEW_SERVER_PORT_SETTING, REVIEW_SERVER_HOST_SETTING } from './reviewConfigurationDefaults.js';

export const REVIEW_SERVER_PORT_ENV = 'WHITEBOARD_SERVER_PORT';
export const REVIEW_VIEWER_TOKEN_ENV = 'WHITEBOARD_VIEWER_TOKEN';
/** The server leaves viewer access off for a shorter token. */
export const REVIEW_VIEWER_TOKEN_MIN_LENGTH = 32;

export type ReviewServerMode = typeof REVIEW_SERVER_MODES[number];

export interface ReviewServerSettings {
	readonly mode: ReviewServerMode;
	readonly host: string;
	/** 0 lets the OS choose, which only an embedded server may do. */
	readonly port: number;
	readonly viewerToken?: string;
}

/** Settings as the configuration service returns them, before validation. */
export interface ReviewServerSettingValues {
	readonly mode?: unknown;
	readonly host?: unknown;
	readonly port?: unknown;
	readonly viewerToken?: unknown;
}

/** The environment wins over settings; a blank value is no value. */
export function resolveReviewServerSettings(values: ReviewServerSettingValues, env: NodeJS.ProcessEnv): ReviewServerSettings {
	const mode = REVIEW_SERVER_MODES.find(candidate => candidate === values.mode) ?? 'embedded';
	const host = text(values.host) ?? '127.0.0.1';
	const envPort = text(env[REVIEW_SERVER_PORT_ENV]);
	const port = envPort !== undefined
		? checkedPort(Number(envPort), envPort, REVIEW_SERVER_PORT_ENV)
		: values.port === undefined || values.port === null
			? 0
			: checkedPort(Number(values.port), String(values.port), REVIEW_SERVER_PORT_SETTING);
	const viewerToken = text(env[REVIEW_VIEWER_TOKEN_ENV]) ?? text(values.viewerToken);
	return { mode, host, port, viewerToken };
}

/**
 * Where an external server answers. Loopback is a tunnel's near end and stays
 * plain http, which the workbench CSP allows; any other host must be https.
 */
export function reviewExternalServerOrigin(host: string, port: number): string {
	if (port === 0) {
		throw new Error(`Set ${REVIEW_SERVER_PORT_SETTING} (or ${REVIEW_SERVER_PORT_ENV}) to the port the Whiteboard server listens on.`);
	}
	// Host names are case-insensitive. IPv6 loopback stays out: the CSP allows
	// only http://127.0.0.1.
	const loopback = host.toLowerCase();
	if (loopback === '127.0.0.1' || loopback === 'localhost') {
		return `http://127.0.0.1:${port}`;
	}
	let url: URL;
	try {
		url = new URL(`https://${host}:${port}`);
	} catch {
		throw new Error(`${REVIEW_SERVER_HOST_SETTING} must be a host name, got ${JSON.stringify(host)}.`);
	}
	// A scheme-prefixed host such as "http://x" parses, but with "http" as the hostname.
	if (url.hostname !== host.toLowerCase()) {
		throw new Error(`${REVIEW_SERVER_HOST_SETTING} must be a host name, got ${JSON.stringify(host)}.`);
	}
	return url.origin;
}

function checkedPort(port: number, raw: string, source: string): number {
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`${source} must be a port between 0 and 65535, got ${raw}.`);
	}
	return port;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
