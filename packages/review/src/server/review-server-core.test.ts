import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { ReviewTelemetry } from "@review/review-telemetry.js";
import { reviewServerDiscoveryPath } from "@review/server-discovery.js";
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
  ): Promise<Running> {
    const local = openLocalReviewStore(path.join(root, "review-api.db"));

    const server = createGlobalReviewServer({
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

    return server.discovery;
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
