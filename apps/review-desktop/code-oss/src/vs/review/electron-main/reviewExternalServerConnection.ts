/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { REVIEW_SERVER_VIEWER_TOKEN_SETTING } from "../common/reviewConfigurationDefaults.js";
import {
  REVIEW_DESKTOP_CONNECTION_VERSION,
  type ReviewDesktopConnection,
} from "../common/reviewDesktopBootstrap.js";
import { REVIEW_VIEWER_TOKEN_ENV } from "../common/reviewServerSettings.js";
import { uuidV7 } from "../common/reviewUuidV7.js";

/** Retry delays while the server is unreachable; the last repeats. */
const EXTERNAL_RETRY_DELAYS = [250, 1_000, 2_000, 4_000];

/** The server answered, but will not take this Desktop as a viewer. Retrying cannot help. */
export class ReviewExternalServerRejectedError extends Error {
  override readonly name = "ReviewExternalServerRejectedError";
}

export interface ReviewExternalServerOptions {
  readonly appVersion: string;
  /** Read at each connection, so it sees the login-shell environment. May throw. */
  readonly resolveEndpoint: () => Promise<{
    readonly origin: string;
    readonly viewerToken?: string;
  }>;
  readonly fetch?: typeof globalThis.fetch;
  readonly retryDelays?: readonly number[];
  readonly logInfo: (message: string) => void;
  readonly logError: (message: string) => void;
}

/**
 * Stands in for the server supervisor when this Desktop reads another
 * machine's server: it starts nothing, and hands renderers a read-only
 * connection once that server accepts the viewer token.
 */
export class ReviewExternalServerConnection extends Disposable {
  readonly appSessionId = uuidV7();
  private readonly stopped = new AbortController();
  private pending: Promise<ReviewDesktopConnection> | undefined;

  constructor(private readonly options: ReviewExternalServerOptions) {
    super();
  }

  /** Probes again on every call, so a relaunched server's new instance is found. */
  whenConnected(): Promise<ReviewDesktopConnection> {
    this.pending ??= this.connect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  start(): void {
    // Nothing runs here; the first renderer's request connects.
  }

  stageRustAnalyzer(): void {
    // Language features stay off for a viewer.
  }

  setTelemetryEnabled(_enabled?: boolean): void {
    // A viewer sends no telemetry to another machine's server.
  }

  async stop(): Promise<void> {
    this.stopped.abort();
  }

  override dispose(): void {
    this.stopped.abort();
    super.dispose();
  }

  private async connect(): Promise<ReviewDesktopConnection> {
    const { origin, viewerToken } = await this.options.resolveEndpoint();
    if (!viewerToken) {
      throw new ReviewExternalServerRejectedError(
        `Set ${REVIEW_SERVER_VIEWER_TOKEN_SETTING} (or ${REVIEW_VIEWER_TOKEN_ENV}) to the viewer token of the Whiteboard server at ${origin}.`,
      );
    }
    const fetch = this.options.fetch ?? globalThis.fetch;
    const delays = this.options.retryDelays ?? EXTERNAL_RETRY_DELAYS;
    let failureLogged = false;
    const logFirstFailure = (reason: string) => {
      if (failureLogged) return;
      failureLogged = true;
      this.options.logError(
        `[Review Desktop] cannot reach the Whiteboard server at ${origin}; retrying: ${reason}`,
      );
    };
    for (let attempt = 0; ; attempt++) {
      if (this.stopped.signal.aborted) throw stoppedError();
      let health: unknown;
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { "x-review-token": viewerToken },
          signal: AbortSignal.any([
            this.stopped.signal,
            AbortSignal.timeout(1_500),
          ]),
        });
        if (response.ok) {
          // A wrong service behind the tunnel answers OK with something else.
          health = await response.json().catch(() => undefined);
          if (!isHealth(health) && !this.stopped.signal.aborted) {
            logFirstFailure("the answer is not a Whiteboard server's health");
          }
        } else {
          logFirstFailure(`HTTP ${response.status}`);
        }
      } catch (error) {
        if (this.stopped.signal.aborted) throw stoppedError();
        logFirstFailure(error instanceof Error ? error.message : String(error));
      }
      if (isHealth(health)) {
        if (health.access !== "viewer") {
          // A server from before viewer support also omits access.
          const versions =
            typeof health.version === "string" && health.version !== this.options.appVersion
              ? ` It runs Whiteboard ${health.version}; this Desktop is ${this.options.appVersion}, and an older server may not support viewers.`
              : "";
          throw new ReviewExternalServerRejectedError(
            `The Whiteboard server at ${origin} did not accept the viewer token. Use the same viewer token on both machines.${versions}`,
          );
        }
        if (typeof health.version === "string" && health.version !== this.options.appVersion) {
          this.options.logError(
            `[Review Desktop] the Whiteboard server at ${origin} runs ${health.version}; this Desktop is ${this.options.appVersion}.`,
          );
        }
        this.options.logInfo(`[Review Desktop] viewing the Whiteboard server at ${origin}`);
        return {
          version: REVIEW_DESKTOP_CONNECTION_VERSION,
          url: origin,
          token: viewerToken,
          instanceId: health.instanceId,
          appSessionId: this.appSessionId,
          access: "viewer",
        };
      }
      if (this.stopped.signal.aborted) throw stoppedError();
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.stopped.signal.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        this.stopped.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

function stoppedError(): Error {
  return new Error("The Whiteboard server connection was stopped.");
}

function isHealth(value: unknown): value is Record<string, unknown> & { instanceId: string } {
  return isRecord(value) && value.ok === true && typeof value.instanceId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
