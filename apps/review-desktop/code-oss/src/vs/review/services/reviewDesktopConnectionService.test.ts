/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
class TestStorage {
	private readonly values = new Map<string, boolean>();

	getBoolean(key: string, _scope: unknown, fallback: boolean): boolean {
		return this.values.get(key) ?? fallback;
	}

	store(key: string, value: boolean): void {
		this.values.set(key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
	}
}

function serviceWith(storage = new TestStorage(), access?: "full" | "viewer"): ReviewDesktopConnectionService {
	const service = new ReviewDesktopConnectionService({} as never, storage as never);
	Object.assign(service, {
		connection: {
			version: 1,
			url: "http://127.0.0.1:5000",
			token: "token",
			instanceId: "instance",
			appSessionId: "session",
			...(access ? { access } : {}),
		},
		initializePromise: Promise.resolve(),
	});
	return service;
}

function mockFetch(t: { after(callback: () => void): void }, handler: typeof fetch): void {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("install status shares concurrent scans and refreshes on subsequent checks", async (t) => {
	const service = serviceWith();
	t.after(() => service.dispose());
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		if (requests === 3) return Response.json({ error: "scan failed" }, { status: 500 });
		return Response.json({
			fingerprint: "test", stamp: null, stale: requests > 1, updateNeeded: false,
			shim: { path: "/tmp/review", installed: false, profileConfigured: false, onPath: false },
			trace: { enabled: false, configured: false, autoActivateRepositories: false, envPath: "/tmp/env", settingsPath: "/tmp/settings" },
			cli: null,
			connect: { command: "review", args: ["mcp"], prompts: { claude: "c", codex: "c", cursor: "c", opencode: "c", pi: "c", omp: "c", copilot: "c" }, plugins: { claude: { label: "c" }, codex: { label: "c" }, cursor: { label: "c" }, opencode: { label: "c" }, pi: { label: "c" }, omp: { label: "c" }, copilot: { label: "c" } } },
			legacySkills: [],
		});
	});

	const [first, second] = await Promise.all([
		service.getCliInstallStatus(),
		service.getCliInstallStatus(),
	]);
	assert.equal(first.stale, false);
	assert.equal(second.stale, false);
	assert.equal(requests, 1);
	assert.equal((await service.getCliInstallStatus()).stale, true);
	assert.equal(requests, 2);
	await assert.rejects(service.getCliInstallStatus(), /scan failed/);
	assert.equal((await service.getCliInstallStatus()).stale, true);
	assert.equal(requests, 4);
});

test("tutorial auto-prepare runs at most once per app process", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ ok: true });
	});

	const first = service.prepareTutorial();
	assert.strictEqual(service.prepareTutorial(), first);
	await first;
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("a failed tutorial auto-prepare is not retried on Welcome activation", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ error: "no agent" }, { status: 409 });
	});

	await assert.rejects(service.prepareTutorial(), /no agent/);
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("tutorial deletion suppresses auto-prepare across restarts until explicit open", async (t) => {
	const storage = new TestStorage();
	const requests: string[] = [];
	mockFetch(t, async (input, init) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/tutorial/open")) {
			return Response.json({
				kind: "api",
				reviewUuid: uuid,
				title: "Tutorial",
			});
		}
		return Response.json({ ok: true });
	});

	const deletingService = serviceWith(storage);
	await deletingService.deleteTutorial();
	deletingService.dispose();

	const suppressedService = serviceWith(storage);
	await suppressedService.prepareTutorial();
	assert.equal(requests.length, 1);
	await suppressedService.openTutorial();
	assert.equal(requests.length, 2);
	assert.match(requests[1] ?? "", /POST .*\/tutorial\/open$/);
	suppressedService.dispose();

	const restoredService = serviceWith(storage);
	await restoredService.prepareTutorial();
	assert.equal(requests.length, 3);
	assert.match(requests[2] ?? "", /POST .*\/tutorial\/prepare$/);
	restoredService.dispose();
});

test("a connection without access is a full one", async (t) => {
	const service = serviceWith();
	t.after(() => service.dispose());

	assert.equal((await service.getConnection()).access, "full");
});

test("a viewer opens what the server sends, names its app session, and answers nothing", async (t) => {
	const service = serviceWith(new TestStorage(), "viewer");
	t.after(() => service.dispose());
	const requests: { url: string; method: string; session: string | null }[] = [];
	const frame = `data: ${JSON.stringify({ event: "desktop-verb", id: uuid, request: { name: "openApiReview", args: { reviewId: uuid, title: "Review" } } })}\n\n`;
	mockFetch(t, async (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			session: new Headers(init?.headers).get("x-review-app-session-id"),
		});
		if (String(input).includes("/control?")) {
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(frame));
					controller.close();
				},
			}), { headers: { "content-type": "text/event-stream" } });
		}
		return Response.json({ ok: true });
	});
	const dispatched: unknown[] = [];

	await (service as unknown as {
		consumeControl(dispatch: (value: unknown) => Promise<{ ok: true }>, onConnected: () => void): Promise<void>;
	}).consumeControl(async (value) => {
		dispatched.push(value);
		return { ok: true };
	}, () => { });

	assert.equal(dispatched.length, 1);
	assert.deepEqual(requests.map(({ method, session }) => ({ method, session })), [{ method: "GET", session: "session" }]);
});

test("a viewer prepares no tutorial on the server it reads", async (t) => {
	const service = serviceWith(new TestStorage(), "viewer");
	t.after(() => service.dispose());
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ ok: true });
	});

	await service.prepareTutorial();

	assert.equal(requests, 0);
});
