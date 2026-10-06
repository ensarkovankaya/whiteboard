import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "@dev.fast/json";
import { STRUCTURAL_DIFF_WIRE_VERSION } from "@dev.fast/review-protocol";
import { openLocalReviewStore } from "@review/review-api/local-data.js";
import type { ReviewStore } from "@review/review-api/store.js";
import { ReviewTelemetry } from "@review/review-telemetry.js";
import { reviewServerDiscoveryPath } from "@review/server-discovery.js";
import { SharedReviewStore } from "@review/sharing/import.js";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "./desktop-server.js";
import { runHeadlessServer } from "./headless-host.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-server-core-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

interface Running {
  url: string;
  token: string;
}

const servers = {
  async desktop(
    options: { token?: string; viewerToken?: string } = {},
  ): Promise<Running & { store: ReviewStore }> {
    const local = openLocalReviewStore(path.join(root, "review-api.db"));
    // As desktop-host runs it, with shared reviews mounted.
    const sharedReviews = new SharedReviewStore(path.join(root, "shared"));
    sharedReviews.connect(local.store, local.data);
    await sharedReviews.load();

    const server = createGlobalReviewServer({
      sharedReviews,
      reviewStore: local.store,
      reviewData: local.data,
      appPid: process.pid,
      packageRoot: root,
      toolingRoot: root,
      port: 0,
      discoveryPath: path.join(root, "desktop-server.json"),
      telemetry: ReviewTelemetry.fromEnv(process.env),
      token: options.token,
      viewerToken: options.viewerToken,
    });

    stops.push(async () => {
      await server.close();
      await local.data.close();
      await local.store.close();
    });
    await server.listen();

    return { ...server.discovery, store: local.store };
  },
  async headless(): Promise<Running> {
    const controller = new AbortController();
    const ready = Promise.withResolvers<Running>();

    const running = runHeadlessServer({
      stateDir: path.join(root, "server"),
      signal: controller.signal,
      onReady: ready.resolve,
    });

    stops.push(async () => {
      controller.abort();
      await running;
    });

    return ready.promise;
  },
};

describe.each(["desktop", "headless"] as const)("the %s server", (kind) => {
  const start = servers[kind];

  it("answers /health without a token, but names no machine or build", async () => {
    const server = await start();

    const callers: Record<string, string>[] = [
      {},
      { "x-review-token": "wrong" },
    ];

    for (const headers of callers) {
      const response = await fetch(`${server.url}/health`, { headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        instanceId: expect.stringMatching(uuid),
        desktopAttached: false,
        version: expect.any(String),
      });
    }
  });

  it("says which store, process and build answer /health to the token", async () => {
    const server = await start();

    const health = await (
      await fetch(`${server.url}/health`, {
        headers: { "x-review-token": server.token },
      })
    ).json();

    expect(health).toMatchObject({
      serverId: expect.stringMatching(uuid),
      serverPid: process.pid,
      version: JSON.parse(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
      ).version,
      // From source there is no build, whatever an old dist holds.
      commit: null,
    });
    expect(health.instanceId).not.toBe(health.serverId);
  });

  it("answers an unknown path with a JSON 404", async () => {
    const server = await start();
    const headers = { "x-review-token": server.token };

    for (const route of ["/nothing-here", "/reviews-api/nothing/here/at/all"]) {
      const response = await fetch(`${server.url}${route}`, { headers });

      expect({
        route,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        route,
        status: 404,
        body: { ok: false, error: "Not found." },
      });
    }
  });

  it("refuses every other route without the right token", async () => {
    const server = await start();

    for (const token of [undefined, "wrong"])
      for (const [method, route] of [
        ["GET", "/reviews-api"],
        ["GET", "/control"],
        ["POST", "/control/result"],
      ] as const) {
        const response = await fetch(`${server.url}${route}`, {
          method,
          headers: token ? { "x-review-token": token } : {},
        });

        expect(response.status, `${method} ${route}`).toBe(401);
      }
  });

  it("answers a preflight from the Desktop's origin with CORS headers", async () => {
    const server = await start();
    const origin = "vscode-file://vscode-app";

    const response = await fetch(`${server.url}/reviews-api`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-review-token",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "x-review-token",
    );
    expect(
      (
        await fetch(`${server.url}/health`, { headers: { origin } })
      ).headers.get("access-control-allow-origin"),
    ).toBe(origin);
  });

  // Each Desktop window attaches its own stream; the Desktop keeps one so a
  // verb never opens in every window.
  const limit = { desktop: 1, headless: 16 }[kind];

  it(`refuses a /control client beyond ${limit} with a well-formed response`, async () => {
    const server = await start();
    const headers = { "x-review-token": server.token };
    const abort = new AbortController();

    try {
      for (let index = 0; index < limit; index++) {
        const attached = await fetch(`${server.url}/control`, {
          headers,
          signal: abort.signal,
        });

        expect(attached.status).toBe(200);
      }

      const refused = await fetch(`${server.url}/control`, { headers });

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ ok: false });

      // Node's parser rejects a reply framed both ways.
      const [raw] = await once(
        request(`${server.url}/control`, { headers }).end(),
        "response",
      );

      expect(raw.statusCode).toBe(409);
      expect(
        raw.headers["transfer-encoding"] && raw.headers["content-length"],
      ).toBeFalsy();
      await once(raw.resume(), "end");
    } finally {
      abort.abort();
    }
  });

  it("answers a malformed /control/result with a JSON 400", async () => {
    const server = await start();

    const response = await fetch(`${server.url}/control/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": server.token,
      },
      body: "not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid JSON body.",
    });
  });
});

describe("a desktop server with a viewer token", () => {
  const viewerToken = "viewer-secret";

  const readOnly = {
    ok: false,
    code: "read-only",
    error: "This Whiteboard connection is read-only.",
  };

  it("tells the viewer token it is a viewer, and names no machine or build", async () => {
    const server = await servers.desktop({ viewerToken });

    const health = await (
      await fetch(`${server.url}/health`, {
        headers: { "x-review-token": viewerToken },
      })
    ).json();

    expect(health).toEqual({
      ok: true,
      instanceId: expect.stringMatching(uuid),
      desktopAttached: false,
      version: expect.any(String),
      access: "viewer",
    });
  });

  it("lets the viewer token read, and refuses every write", async () => {
    const server = await servers.desktop({ viewerToken });
    const headers = { "x-review-token": viewerToken };

    expect((await fetch(`${server.url}/reviews-api`, { headers })).status).toBe(
      200,
    );

    for (const [method, route] of [
      ["POST", "/control/result"],
      ["POST", "/reviews-api/commands"],
      ["PUT", "/preferences/scratchpad"],
      ["DELETE", "/tutorial"],
      ["POST", "/install/apply"],
      ["POST", "/telemetry/event"],
    ] as const) {
      const response = await fetch(`${server.url}${route}`, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });

      expect({
        route,
        status: response.status,
        body: await response.json(),
      }).toEqual({ route, status: 403, body: readOnly });
    }
  });

  const reviewId = "00000000-0000-4000-8000-000000000000";

  /** Status, and the body of a refusal; a stream is cut once it answers. */
  const call = async (
    server: Running,
    method: string,
    route: string,
    token = viewerToken,
  ) => {
    const abort = new AbortController();

    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: {
        "x-review-token": token,
        ...(method === "POST" && { "content-type": "application/json" }),
      },
      ...(method === "POST" && { body: "{}" }),
      signal: abort.signal,
    });

    const body =
      response.status === 403 && method !== "HEAD"
        ? await response.json()
        : undefined;

    abort.abort();

    return { route: `${method} ${route}`, status: response.status, body };
  };

  it("lets the viewer token reach every route that shows a review", async () => {
    const server = await servers.desktop({ viewerToken });
    const review = `/reviews-api/${reviewId}`;

    for (const [method, route] of [
      ["GET", "/reviews-api"],
      ["HEAD", "/reviews-api"],
      ["GET", "/reviews-api?mode=textual"],
      ["GET", "/reviews-api/watch"],
      ["GET", review],
      ["GET", `${review}/watch`],
      ["GET", `${review}/inspect`],
      ["GET", `${review}/history`],
      ["GET", `${review}/stack`],
      ["GET", `${review}/activity`],
      ["GET", `${review}/progress`],
      ["GET", `${review}/lenses`],
      ["GET", `${review}/commits`],
      ["GET", `${review}/tree`],
      ["GET", `${review}/diff`],
      ["GET", `${review}/file?side=head&file=README.md`],
      ["GET", `${review}/structural-diff`],
      ["GET", `${review}/agent-traces`],
      ["GET", `${review}/agent-traces/session-1`],
      ["GET", `${review}/maps/map-1`],
      ["GET", `${review}/resources/image-1`],
      ["GET", `/reviews-api/sharing/import/shared-${"0".repeat(64)}`],
      ["POST", `${review}/copy-context`],
      // No app session: refused by the relay, not by the allowlist.
      ["GET", "/control"],
    ] as const) {
      const result = await call(server, method, route);

      expect({
        route: result.route,
        refused: [401, 403].includes(result.status),
      }).toEqual({ route: result.route, refused: false });
    }
  });

  it("refuses the viewer token every other route, GET or unknown included", async () => {
    const server = await servers.desktop({ viewerToken });
    const review = `/reviews-api/${reviewId}`;

    for (const [method, route] of [
      // Prepares checkouts and runs devfast.prepare on the server machine.
      ["GET", `${review}/language-context`],
      ["GET", `${review}/workspaces`],
      ["GET", `${review}/ask/threads`],
      // The server machine's own state and settings.
      ["GET", "/reviews-api/status"],
      ["GET", "/reviews-api/capabilities"],
      ["GET", "/reviews-api/authoring"],
      ["GET", "/reviews-api/instructions"],
      ["GET", "/reviews-api/sharing/account"],
      ["GET", "/install/status"],
      ["HEAD", "/install/status"],
      ["GET", "/tutorial/status"],
      ["GET", "/preferences/scratchpad"],
      ["GET", "/diffr-config"],
      // Writes.
      ["POST", "/reviews-api/sharing/import"],
      ["POST", `${review}/progress`],
      ["POST", `${review}/navigator`],
      ["POST", "/app/focus"],
      ["POST", "/crash-reports"],
      // A route no one registered is closed too, not a 404.
      ["GET", "/nothing-here"],
      ["GET", "/reviews-api/nothing/here/at/all"],
    ] as const) {
      expect(await call(server, method, route)).toEqual({
        route: `${method} ${route}`,
        status: 403,
        body: method === "HEAD" ? undefined : readOnly,
      });
    }

    // The full token still reaches them.
    for (const route of ["/install/status", "/reviews-api/status"])
      expect((await call(server, "GET", route, server.token)).status).toBe(200);
  });

  it("keeps Ask closed to the viewer token, even for GET", async () => {
    const server = await servers.desktop({ viewerToken });
    const reviewId = "00000000-0000-4000-8000-000000000000";

    for (const route of [
      `/reviews-api/${reviewId}/ask/agents/claude/offer`,
      `/reviews-api/${reviewId}/ask/threads`,
      `/reviews-api/${reviewId}/ask/mentions`,
      `/reviews-api/${reviewId}/ask`,
      // The router decodes the path, so an encoded "ask" must not slip past.
      `/reviews-api/${reviewId}/%61sk/agents/claude/offer`,
      `/reviews-api/${reviewId}/as%6b/threads`,
      `/reviews-api/${reviewId}/%61%73%6b`,
    ]) {
      const response = await fetch(`${server.url}${route}`, {
        headers: { "x-review-token": viewerToken },
      });

      expect({
        route,
        status: response.status,
        body: await response.json(),
      }).toEqual({ route, status: 403, body: readOnly });
    }
  });

  it("lets the viewer token copy context", async () => {
    const server = await servers.desktop({ viewerToken });

    const response = await fetch(
      `${server.url}/reviews-api/00000000-0000-4000-8000-000000000000/copy-context?mode=all`,
      {
        method: "POST",
        headers: {
          "x-review-token": viewerToken,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(401);
  });

  it("refuses a viewer token it was not given", async () => {
    const server = await servers.desktop();
    const headers = { "x-review-token": viewerToken };

    expect((await fetch(`${server.url}/reviews-api`, { headers })).status).toBe(
      401,
    );
    expect(
      await (await fetch(`${server.url}/health`, { headers })).json(),
    ).not.toHaveProperty("access");
  });

  it("treats a viewer token equal to its own token as the full token", async () => {
    const server = await servers.desktop({
      token: "same-secret",
      viewerToken: "same-secret",
    });

    const health = await (
      await fetch(`${server.url}/health`, {
        headers: { "x-review-token": "same-secret" },
      })
    ).json();

    expect(health).toHaveProperty("serverId");
    expect(health).not.toHaveProperty("access");
  });

  it("attaches a viewer's /control beside the Desktop's, one per app session", async () => {
    const server = await servers.desktop({ viewerToken });
    const abort = new AbortController();

    const viewer = {
      "x-review-token": viewerToken,
      "x-review-app-session-id": "client2-session",
    };

    try {
      const primary = await fetch(`${server.url}/control`, {
        headers: { "x-review-token": server.token },
        signal: abort.signal,
      });

      const first = await fetch(`${server.url}/control`, {
        headers: viewer,
        signal: abort.signal,
      });

      expect(primary.status).toBe(200);
      expect(first.status).toBe(200);
      expect(
        (await fetch(`${server.url}/control`, { headers: viewer })).status,
      ).toBe(409);
      // Without an app session a viewer cannot be told apart, so it is refused.
      expect(
        (
          await fetch(`${server.url}/control`, {
            headers: { "x-review-token": viewerToken },
          })
        ).status,
      ).toBe(409);

      // The primary Desktop's /control is what makes it attached.
      const health = await (await fetch(`${server.url}/health`)).json();

      expect(health.desktopAttached).toBe(true);
    } finally {
      abort.abort();
    }
  });

  it("lets a viewer's own connection reattach over its stale /control", async () => {
    const server = await servers.desktop({ viewerToken });
    const abort = new AbortController();

    const viewer = (connection: string) => ({
      "x-review-token": viewerToken,
      "x-review-app-session-id": "client2-session",
      "x-review-control-id": connection,
    });

    try {
      const stale = await fetch(`${server.url}/control`, {
        headers: viewer("window-1"),
        signal: abort.signal,
      });

      expect(stale.status).toBe(200);
      expect(
        (await fetch(`${server.url}/control`, { headers: viewer("window-2") }))
          .status,
      ).toBe(409);

      const reconnected = await fetch(`${server.url}/control`, {
        headers: viewer("window-1"),
        signal: abort.signal,
      });

      expect(reconnected.status).toBe(200);
      // The replaced stream is ended by the server.
      await expect(stale.text()).resolves.toBe(": attached\n\n");
    } finally {
      abort.abort();
    }
  });

  it("does not count a viewer as an attached Desktop", async () => {
    const server = await servers.desktop({ viewerToken });
    const abort = new AbortController();

    try {
      await fetch(`${server.url}/control`, {
        headers: {
          "x-review-token": viewerToken,
          "x-review-app-session-id": "client2-session",
        },
        signal: abort.signal,
      });

      expect(
        (await (await fetch(`${server.url}/health`)).json()).desktopAttached,
      ).toBe(false);
    } finally {
      abort.abort();
    }
  });
});

describe("what a viewer token reads", () => {
  const viewerToken = "viewer-secret";

  const readOnly = {
    ok: false,
    code: "read-only",
    error: "This Whiteboard connection is read-only.",
  };

  /**
   * A checkout with a base and a head commit, a live edit, an untracked file
   * and an ignored .env; a later commit no review pins; another registered
   * repository; and a live and a commits review of the first.
   */
  const fixture = async () => {
    const server = await servers.desktop({ viewerToken });

    const repository = async (name: string) => {
      const directory = path.join(root, name);
      await mkdir(directory);

      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

      git("init", "-q", "-b", "main");
      git("config", "user.name", "Review Test");
      git("config", "user.email", "review-test@example.invalid");
      git("config", "commit.gpgsign", "false");

      return { directory, git };
    };

    const { directory: repo, git } = await repository("repo");
    await writeFile(path.join(repo, ".gitignore"), ".env\n");
    await writeFile(path.join(repo, "tracked.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "Base");
    const base = git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "tracked.ts"), "export const value = 2;\n");
    git("commit", "-qam", "Head");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-qb", "later");
    await writeFile(path.join(repo, "later.ts"), "not in any review\n");
    git("add", ".");
    git("commit", "-qm", "Later");
    const later = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    await writeFile(path.join(repo, "tracked.ts"), "export const value = 3;\n");
    await writeFile(path.join(repo, ".env"), "SECRET=client1\n");
    await writeFile(path.join(repo, "untracked.ts"), "not added\n");

    const { directory: other, git: otherGit } = await repository("other");
    await writeFile(path.join(other, "secret.ts"), "another repository\n");
    otherGit("add", ".");
    otherGit("commit", "-qm", "Other");
    const otherHead = otherGit("rev-parse", "HEAD");

    const full = { "x-review-token": server.token };

    const post = async <T>(route: string, body: JsonObject): Promise<T> => {
      const response = await fetch(`${server.url}/reviews-api${route}`, {
        method: "POST",
        headers: { ...full, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect({ route, status: response.status }).toEqual({
        route,
        status: 200,
      });

      return response.json();
    };

    const create = (target: {
      kind: "worktree" | "commits";
      repositoryPath: string;
      base: string;
      head?: string;
    }) =>
      post<{ reviewId: string; version: number }>("/commands", {
        operation: { type: "create", title: "Viewer scope", target },
      });

    const live = await create({ kind: "worktree", repositoryPath: repo, base });

    const commits = await create({
      kind: "commits",
      repositoryPath: repo,
      base,
      head,
    });

    const { id: otherId } = await post<{ id: string }>("/repositories", {
      path: other,
    });

    const { pins } = await (
      await fetch(`${server.url}/reviews-api/${commits.reviewId}?full=true`, {
        headers: full,
      })
    ).json();

    const read = (route: string, token = viewerToken) =>
      fetch(`${server.url}/reviews-api${route}`, {
        headers: { "x-review-token": token },
      });

    /** Copies a selection of the first line of `file`, as the canvas does. */
    const copy = (
      reviewId: string,
      file: string,
      source: { commit?: string; pins?: Record<string, string> } = {},
    ) =>
      fetch(`${server.url}/reviews-api/${reviewId}/copy-context`, {
        method: "POST",
        headers: {
          "x-review-token": viewerToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          target: {
            kind: "code",
            path: file,
            side: "head",
            startLine: 1,
            endLine: 1,
          },
          title: "Selection",
          apiSource: {
            reviewId,
            version:
              reviewId === live.reviewId ? live.version : commits.version,
            ...source,
          },
        }),
      });

    return {
      server,
      repo,
      git,
      base,
      head,
      later,
      other: { id: otherId, head: otherHead },
      repositoryId: pins.repositoryId as string,
      live: live.reviewId,
      commits: commits.reviewId,
      read,
      copy,
    };
  };

  it("reads a live review's tracked and changed files, never its untracked, ignored or Git files", async () => {
    const { live, read, copy, server } = await fixture();

    const file = (name: string) =>
      `/${live}/file?side=head&file=${encodeURIComponent(name)}`;

    const tracked = await read(file("tracked.ts"));

    expect(tracked.status).toBe(200);
    expect(await tracked.json()).toMatchObject({
      text: "export const value = 3;\n",
    });

    for (const name of [
      ".env",
      "untracked.ts",
      ".git/config",
      ".GIT/config",
      "sub/.Git/HEAD",
    ]) {
      const response = await read(file(name));

      expect({
        name,
        status: response.status,
        body: await response.json(),
      }).toEqual({ name, status: 403, body: readOnly });
    }

    // Copying a selection quotes the file the same way.
    expect((await copy(live, "tracked.ts")).status).toBe(200);
    expect(await (await copy(live, ".env")).json()).toEqual(readOnly);

    // The full token reads the checkout as before.
    const secret = await read(file(".env"), server.token);

    expect(secret.status).toBe(200);
    expect(await secret.json()).toMatchObject({ text: "SECRET=client1\n" });
  });

  it("reads only the review's repository and the commits it pins", async () => {
    const {
      commits,
      live,
      read,
      copy,
      server,
      repo,
      git,
      repositoryId,
      base,
      head,
      later,
      other,
    } = await fixture();

    const at = (pins: Record<string, string>) =>
      new URLSearchParams(pins).toString();

    const pinned = at({ repositoryId, head, base });

    // A live review compares with the checkout as it is now.
    await writeFile(path.join(repo, "next.ts"), "committed after review\n");
    git("add", "next.ts");
    git("commit", "-qm", "Next");
    const next = git("rev-parse", "HEAD");

    // The review's own pins, named as a reference names them.
    for (const route of [
      `/${live}/file?side=head&file=next.ts&commit=${next}`,
      `/${commits}/file?side=head&file=tracked.ts&${pinned}`,
      `/${commits}/tree?${pinned}`,
      `/${commits}/diff?${pinned}`,
      `/${commits}/file?side=head&file=tracked.ts&commit=${head}`,
      `/${live}/file?side=base&file=tracked.ts&${pinned}`,
    ])
      expect({ route, status: (await read(route)).status }).toEqual({
        route,
        status: 200,
      });

    const foreign = [
      // Another registered repository.
      `/${commits}/file?side=head&file=secret.ts&${at({ repositoryId: other.id, head: other.head })}`,
      `/${commits}/tree?${at({ repositoryId: other.id, head: other.head })}`,
      // A commit of this repository that no review version pins.
      `/${commits}/file?side=head&file=later.ts&${at({ repositoryId, head: later })}`,
      `/${commits}/diff?${at({ repositoryId, head: later, base })}`,
      `/${commits}/structural-diff?${at({ repositoryId, head: later, base })}`,
      `/${live}/tree?${at({ repositoryId, head: later })}`,
      `/${commits}/file?side=head&file=later.ts&commit=${later}`,
    ];

    for (const route of foreign) {
      const response = await read(route);

      expect({
        route,
        status: response.status,
        body: await response.json(),
      }).toEqual({ route, status: 403, body: readOnly });
    }

    for (const source of [
      { pins: { repositoryId: other.id, head: other.head } },
      { pins: { repositoryId, head: later } },
      { commit: later },
    ]) {
      const response = await copy(commits, "tracked.ts", source);

      expect({
        source,
        status: response.status,
        body: await response.json(),
      }).toEqual({ source, status: 403, body: readOnly });
    }

    expect((await copy(commits, "tracked.ts", { commit: head })).status).toBe(
      200,
    );

    // The full token still reads at any pins.
    expect(
      (await read(foreign[0]!, server.token)).status,
      "full token, another repository",
    ).toBe(200);
  });

  it("reads only the agent traces of the review's commits", async () => {
    const { commits, read, server } = await fixture();
    const route = `/${commits}/agent-traces/00000000-0000-4000-8000-000000000001`;

    const response = await read(route);

    expect(await response.json()).toEqual(readOnly);
    expect(response.status).toBe(403);
    expect((await read(route, server.token)).status).not.toBe(403);
  });

  it("shows no stack it would have to ask GitHub for with this machine's login", async () => {
    const bin = path.join(root, "bin");
    const log = path.join(root, "gh.log");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
echo '[{"pull_requests":[{"number":2,"head":{"ref":"feature"}}]}]'
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);

    const { server, read, repositoryId, base, head } = await fixture();

    const { reviewId } = await server.store.execute(
      {
        operation: {
          type: "create",
          title: "Stacked",
          target: { kind: "commits", repositoryId, base, head },
        },
      },
      {
        document: [],
        origin: {
          pullRequestUrl: "https://github.com/owner/repo/pull/2",
          pullRequestNumber: 2,
        },
      },
    );

    expect(await (await read(`/${reviewId}/stack`)).json()).toEqual({
      layers: [],
    });
    await expect(readFile(log, "utf8")).rejects.toThrow("ENOENT");

    const { layers } = await (
      await read(`/${reviewId}/stack`, server.token)
    ).json();

    expect(layers).toHaveLength(1);
    expect(await readFile(log, "utf8")).toContain("repos/owner/repo/stacks");
  });

  it("names no path on the server machine", async () => {
    const { live, commits, read, repo, server } = await fixture();
    const paths = [repo, await realpath(repo)];

    const viewed = await read(`/${live}/file?side=head&file=tracked.ts`);

    const body = await viewed.json();

    expect(body).not.toHaveProperty("localPath");
    expect(body).not.toHaveProperty("localRoot");

    for (const route of [
      "",
      "/watch",
      `/${live}?full=true`,
      `/${live}/watch`,
      `/${live}/tree`,
      `/${commits}?full=true`,
      `/${commits}/commits`,
      `/${commits}/inspect?full=true&format=json`,
    ]) {
      const abort = new AbortController();

      const response = await fetch(`${server.url}/reviews-api${route}`, {
        headers: { "x-review-token": viewerToken },
        signal: abort.signal,
      });

      // A watch stream's first line is its whole first state.
      const text = route.endsWith("watch")
        ? await firstLine(response)
        : await response.text();

      abort.abort();
      expect({ route, status: response.status }).toEqual({
        route,
        status: 200,
      });

      for (const local of paths)
        expect(text, `${route} names ${local}`).not.toContain(local);
    }

    // The Desktop on this machine still follows the file on disk.
    expect(
      await (
        await read(`/${live}/file?side=head&file=tracked.ts`, server.token)
      ).json(),
    ).toHaveProperty("localPath");
  });

  it("diffs without the LLM summarizer, while the full token keeps it", async () => {
    // Stands in for diffr: records each comparison's configuration and
    // answers with an empty diff; `config show` prints the user's settings.
    const xdg = path.join(root, "xdg");
    await mkdir(path.join(xdg, "git"), { recursive: true });
    await writeFile(path.join(xdg, "git", "ignore"), ".env\n");
    const log = path.join(root, "diffr.log");
    const diffr = path.join(root, "fake-diffr");

    const settings = [
      "version = 1",
      "[plugins]",
      'order = ["bundled.context", "bundled.summarize", "external.remote"]',
      "[plugins.bundled.context]",
      "lines = 7",
      "[plugins.bundled.summarize]",
      "enabled = true",
      'provider = "gemini"',
      "[plugins.external.remote]",
      'path = "/plugins/remote.wasm"',
    ].join("\n");

    await writeFile(
      diffr,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "config") {
  process.stdout.write(${JSON.stringify(`${settings}\n`)});
  return;
}
const home = process.env.XDG_CONFIG_HOME;
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  home,
  config: read(home + "/diffr/config.toml"),
  gitIgnore: read(home + "/git/ignore"),
}) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({
  type: "start",
  version: ${STRUCTURAL_DIFF_WIRE_VERSION},
  lhs: { type: "revision", rev: "base" },
  rhs: { type: "revision", rev: "head" },
  files: [],
});
emit({ type: "complete", succeeded: 0, failed: 0 });
`,
      { mode: 0o755 },
    );
    vi.stubEnv("REVIEW_DIFFR_BINARY", diffr);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);

    const { live, read, server } = await fixture();

    const runs = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    // Coverage and the structural diff a viewer asks for.
    expect((await read(`/${live}/progress`)).status).toBe(200);
    expect(await (await read(`/${live}/structural-diff`)).text()).toContain(
      '"complete"',
    );

    const viewerRuns = await runs();

    expect(viewerRuns.length).toBeGreaterThan(0);

    for (const run of viewerRuns) {
      expect(run.home).not.toBe(xdg);
      expect(parseToml(run.config)).toEqual({
        version: 1,
        plugins: {
          order: ["bundled.context", "bundled.summarize"],
          bundled: {
            context: { lines: 7 },
            summarize: { enabled: false, provider: "gemini" },
          },
        },
      });
      // Git still reads the user's own configuration, global ignores included.
      expect(run.gitIgnore).toBe(".env\n");
    }

    expect(
      await (await read(`/${live}/structural-diff`, server.token)).text(),
    ).toContain('"complete"');

    expect((await runs()).slice(viewerRuns.length)).toEqual([
      { home: xdg, config: null, gitIgnore: ".env\n" },
    ]);
  });
});

async function firstLine(response: Response): Promise<string> {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();

  let text = "";

  while (!text.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) break;
    text += value;
  }

  await reader.cancel();

  return text;
}

// The servers as they run: the Desktop's host process and `server start`.
const processes = {
  desktop: (home: string) =>
    spawnSource("src/server/desktop-host.ts", [], {
      DEV_REVIEW_HOME: home,
      DEV_FAST_REVIEW_SERVER_PORT: "0",
      DEV_FAST_REVIEW_APP_PID: String(process.pid),
    }),
  headless: (home: string, stateDir = path.join(home, "server")) =>
    spawnSource(
      "src/cli.ts",
      ["server", "start", "--json", "--state-dir", stateDir],
      { DEV_REVIEW_HOME: home },
    ),
};

it("gives the Desktop and headless servers on one home one serverId, and another home another", async () => {
  const other = path.join(root, "other");

  // Started together, so both race to create the id.
  const children = [
    ["desktop", processes.desktop(root), undefined],
    ["headless", processes.headless(root, root), root],
    ["headless", processes.headless(other, other), other],
  ] as const;

  try {
    const [desktop, headless, elsewhere] = await Promise.all(
      children.map(async ([kind, child, stateDir]) => {
        const server = await discovery(kind, child, stateDir);

        return (
          await (
            await fetch(`${server.url}/health`, {
              headers: { "x-review-token": server.token },
            })
          ).json()
        ).serverId;
      }),
    );

    expect(desktop).toMatch(uuid);
    expect(headless).toBe(desktop);
    expect(elsewhere).toMatch(uuid);
    expect(elsewhere).not.toBe(desktop);
  } finally {
    await Promise.all(
      children.map(async ([, child]) => {
        if (child.exitCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
  }
}, 30_000);

it.each([
  ["desktop", 1],
  ["headless", 1],
  ["headless", 2],
] as const)(
  "the %s server exits on SIGTERM with %i /control clients attached",
  async (kind, clients) => {
    const child = processes[kind](root);
    const exited = once(child, "exit");

    try {
      const server = await discovery(kind, child);

      for (let index = 0; index < clients; index++) {
        const control = await fetch(`${server.url}/control`, {
          headers: { "x-review-token": server.token },
        });

        expect(control.status).toBe(200);
      }

      child.kill("SIGTERM");

      // Under the headless server's 5 s force-close: the relay must end the
      // streams itself.
      let timer: NodeJS.Timeout | undefined;

      const [code] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("still running after 3 s")),
            3_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));

      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
  20_000,
);

it("refuses to reset the id while a paused headless server holds the store", async ({
  onTestFinished,
}) => {
  const stateDir = path.join(root, "server");
  const child = processes.headless(root, stateDir);
  const exited = once(child, "exit");

  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }

    await exited;
  });

  const server = await discovery("headless", child, stateDir);

  const serverId = async () =>
    (
      await (
        await fetch(`${server.url}/health`, {
          headers: { "x-review-token": server.token },
        })
      ).json()
    ).serverId;

  const before = await serverId();
  child.kill("SIGSTOP");

  const reset = spawnSource(
    "src/cli.ts",
    ["--state-dir", stateDir, "server", "reset-id", "--json"],
    { DEV_REVIEW_HOME: root },
  );

  let output = "";
  reset.stdout!.on("data", (chunk) => (output += chunk));
  const [code] = await once(reset, "exit");

  expect(code).toBe(1);
  expect(JSON.parse(output).error.message).toMatch(/Stop it first/);

  child.kill("SIGCONT");
  expect(await serverId()).toBe(before);

  const local = openLocalReviewStore(path.join(stateDir, "review-api.db"));
  onTestFinished(async () => {
    await local.data.close();
    await local.store.close();
  });
  expect(local.store.serverId()).toBe(before);
}, 30_000);

function spawnSource(
  entry: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...env,
      DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
      DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function discovery(
  kind: string,
  child: ChildProcess,
  stateDir = path.join(root, "server"),
): Promise<Running> {
  let output = "";
  let errors = "";
  const ready = Promise.withResolvers<void>();

  child.stdout!.on("data", (chunk) => {
    output += chunk;

    if (/"(ready|server\.ready)"/.test(output)) ready.resolve();
  });
  child.stderr!.on("data", (chunk) => {
    errors += chunk;
  });
  child.once("exit", (code, signal) =>
    ready.reject(
      new Error(
        `The ${kind} server exited before ready (${signal ?? code}):\n${errors}`,
      ),
    ),
  );
  await ready.promise;

  if (kind === "desktop")
    return JSON.parse(
      output.split("\n").find((line) => line.includes('"ready"'))!,
    );

  return JSON.parse(
    await readFile(reviewServerDiscoveryPath(stateDir), "utf8"),
  );
}
