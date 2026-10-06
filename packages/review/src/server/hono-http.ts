import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { type HttpBindings, getRequestListener } from "@hono/node-server";
import { REVIEW_APP_SESSION_ID_HEADER } from "@review/ui-telemetry-events";
import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { StreamLimitError, readBoundedStream } from "./bounded-stream.js";
import { DEFAULT_MAX_REQUEST_BYTES, HttpJsonError } from "./http-json";

/** Names one Desktop window's control stream, so it can take over its own stale slot. */
export const REVIEW_CONTROL_ID_HEADER = "x-review-control-id";

export type ReviewHonoEnv = {
  Bindings: HttpBindings;
  Variables: ReviewAccessVariables;
};

/** Set by the token check on every authenticated request. */
export type ReviewAccessVariables = { access: ReviewRequestAccess };

export function createNodeRequestListener(
  app: Hono<ReviewHonoEnv>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return getRequestListener(app.fetch);
}

export function jsonResponse<T>(
  body: T,
  status: ContentfulStatusCode,
  options: {
    cacheControl?: string;
    contentType?: string;
    newline?: boolean;
  } = {},
): Response {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json; charset=utf-8",
  });

  if (options.cacheControl) {
    headers.set("cache-control", options.cacheControl);
  }

  const serialized = JSON.stringify(body);

  return new Response(
    options.newline === false ? serialized : `${serialized}\n`,
    {
      status,
      headers,
    },
  );
}

export function applyCorsHeaders(
  request: Request,
  response: Response,
): Response {
  const origin = request.headers.get("origin");

  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    const vary = response.headers.get("vary");

    const varyFields = vary
      ?.split(",")
      .map((field) => field.trim().toLowerCase());

    if (!varyFields?.includes("*") && !varyFields?.includes("origin")) {
      response.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
    }
  }

  response.headers.set(
    "access-control-allow-headers",
    `content-type, x-review-token, ${REVIEW_APP_SESSION_ID_HEADER}, ${REVIEW_CONTROL_ID_HEADER}`,
  );
  response.headers.set(
    "access-control-allow-methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.headers.set("access-control-allow-private-network", "true");

  return response;
}

export function corsPreflightResponse(request: Request): Response {
  return applyCorsHeaders(request, new Response(null, { status: 204 }));
}

export function isAuthorizedRequest(
  request: Request,
  expectedToken: string,
): boolean {
  const supplied =
    request.headers.get("x-review-token") ??
    new URL(request.url).searchParams.get("token");

  if (!supplied) return false;
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);

  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

/** Which credential a request carries: the server's own, or the read-only viewer's. */
export type ReviewRequestAccess = "full" | "viewer";

export function requestAccess(
  request: Request,
  token: string,
  viewerToken?: string,
): ReviewRequestAccess | null {
  if (isAuthorizedRequest(request, token)) return "full";

  if (viewerToken && isAuthorizedRequest(request, viewerToken)) return "viewer";

  return null;
}

/**
 * Everything a read-only viewer may call: the route patterns that show one
 * review, by method. Whatever is not listed is refused, GET included, so a
 * route added later stays closed to viewers until it is listed here. Closed on
 * purpose: Ask, language-context and workspaces (they prepare checkouts and
 * run commands here), status, capabilities, authoring, instructions, install,
 * tutorial, preferences, diffr settings, sharing account/login/publish, and
 * every write but copy-context.
 */
const VIEWER_ROUTES = {
  GET: new Set([
    // The Desktop verb stream; a viewer hears only what opens a review.
    "/control",
    // The review list and its live stream.
    "/reviews-api",
    "/reviews-api/watch",
    // One review: its document at any version, live, with its history.
    "/reviews-api/:id",
    "/reviews-api/:id/watch",
    "/reviews-api/:id/inspect",
    "/reviews-api/:id/history",
    "/reviews-api/:id/stack",
    "/reviews-api/:id/activity",
    // Its coverage and lenses.
    "/reviews-api/:id/progress",
    "/reviews-api/:id/lenses",
    // Its source; http.ts keeps these to the review's repository and commits.
    "/reviews-api/:id/commits",
    "/reviews-api/:id/tree",
    "/reviews-api/:id/diff",
    "/reviews-api/:id/file",
    "/reviews-api/:id/structural-diff",
    // What the document embeds, and the agent traces of its commits.
    "/reviews-api/:id/maps/:resourceId",
    "/reviews-api/:id/resources/:resourceId",
    "/reviews-api/:id/agent-traces",
    "/reviews-api/:id/agent-traces/:sessionId",
    // How the import of a shared review is going.
    "/reviews-api/sharing/import/:id",
  ]),
  POST: new Set([
    // The Markdown a viewer copies for its own agent; it writes nothing.
    "/reviews-api/:id/copy-context",
  ]),
};

/** What a viewer is told for anything it may not do. */
export const VIEWER_READ_ONLY = {
  ok: false,
  code: "read-only",
  error: "This Whiteboard connection is read-only.",
} as const;

/** A route refuses a viewer something outside the review it shows. */
export class ViewerReadOnlyError extends Error {
  constructor() {
    super(VIEWER_READ_ONLY.error);
    this.name = "ViewerReadOnlyError";
  }
}

/** Whether a viewer may call the route that answers `method` (HEAD as GET). */
export function viewerMayRequest(
  method: string,
  route: string | undefined,
): boolean {
  const routes =
    method === "GET" || method === "HEAD"
      ? VIEWER_ROUTES.GET
      : method === "POST"
        ? VIEWER_ROUTES.POST
        : undefined;

  return route !== undefined && (routes?.has(route) ?? false);
}

/**
 * The pattern of the route that will answer this request: the first handler
 * (not middleware) the router matched for the decoded path, so an encoded
 * segment or an ambiguous `/:id` cannot stand in for another route.
 */
export function answeringRoute(context: Context): string | undefined {
  const method = context.req.method === "HEAD" ? "GET" : context.req.method;

  return matchedRoutes(context).find((route) => route.method === method)?.path;
}

export async function readBoundedRequestJson(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BYTES,
  emptyValue?: JsonValue,
  options: { allowTextPlain?: boolean } = {},
): Promise<JsonValue> {
  assertJsonContentType(request, options);
  const contentLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw requestTooLarge(maxBytes);
  }

  let body: string;

  try {
    body = request.body
      ? (await readBoundedStream(request.body, maxBytes)).toString("utf8")
      : "";
  } catch (error) {
    if (error instanceof StreamLimitError) throw requestTooLarge(maxBytes);
    throw error;
  }

  if (!body && emptyValue !== undefined) return emptyValue;

  try {
    return parseJsonText(body);
  } catch {
    throw new HttpJsonError("Invalid JSON body.", 400);
  }
}

function assertJsonContentType(
  request: Request,
  options: { allowTextPlain?: boolean },
): void {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();

  if (
    mediaType !== "application/json" &&
    !mediaType?.endsWith("+json") &&
    !(options.allowTextPlain && mediaType === "text/plain")
  ) {
    throw new HttpJsonError("Content-Type must be application/json.", 415);
  }
}

function requestTooLarge(maxBytes: number): HttpJsonError {
  return new HttpJsonError(
    `Request body exceeds ${maxBytes === DEFAULT_MAX_REQUEST_BYTES ? "1 MiB" : `${maxBytes} bytes`}.`,
    413,
  );
}
