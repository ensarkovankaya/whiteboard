import {
  TraceConfigurationError,
  TraceStorageDeniedError,
  type TraceStorageKind,
  isS3MockMode,
  isTraceStorageConfigured,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  resolveTraceStorage,
  selectTraceStorage,
} from "@dev.fast/trace-core";

import type { Pins } from "./document.js";

/** Who reads the traces, as the HTTP layer knows it. */
export interface TraceCaller {
  /**
   * A read-only viewer: only the traces this machine already saved. No
   * store, no pull request fetch, and no store choice of its own.
   */
  viewer?: boolean;
  /** On another machine: configuration errors name this machine's paths. */
  remote?: boolean;
}

const REMOTE_CONFIGURATION_ERROR =
  "The trace storage configuration on the server machine is invalid. The server logged the cause.";

/** A configuration error as this caller may read it; the log keeps the cause. */
function configurationError(message: string, caller: TraceCaller) {
  if (!caller.remote) return message;
  console.error(`[Review API] trace storage configuration: ${message}`);

  return REMOTE_CONFIGURATION_ERROR;
}

export async function listPinnedTraces(
  cwd: string,
  pins: Pins,
  override?: TraceStorageKind,
  caller: TraceCaller = {},
) {
  const selection = selectTraceStorage();
  const sources: TraceStorageKind[] = [];

  if (!caller.viewer) {
    if (selection.s3?.credentials || isS3MockMode()) sources.push("s3");

    if (selection.hosted) sources.push("hosted");
  }

  const result = {
    ok: true as const,
    configured: isTraceStorageConfigured(),
    storage: (caller.viewer ? undefined : override) ?? selection.mode,
    sources,
  };

  try {
    if (selection.error)
      return {
        ...result,
        storageError: configurationError(selection.error, caller),
        sessions: [],
      };

    if (caller.viewer)
      return {
        ...result,
        sessions: await listReviewTraceSessions({
          rootPath: cwd,
          baseCommit: pins.base,
          headCommit: pins.head,
          offline: true,
        }),
      };
    const storage = await resolveTraceStorage({ cwd, override });

    if (!storage && (override ?? selection.mode) === "hosted")
      return {
        ...result,
        storageError:
          "The hosted trace store has no login on this machine. Run `whiteboard login` and open the review again.",
        sessions: [],
      };

    return {
      ...result,
      sessions: await listReviewTraceSessions({
        rootPath: cwd,
        baseCommit: pins.base,
        headCommit: pins.head,
        storage,
      }),
    };
  } catch (error) {
    if (error instanceof TraceStorageDeniedError)
      return { ...result, storageError: error.message, sessions: [] };

    if (error instanceof TraceConfigurationError)
      return {
        ...result,
        storageError: configurationError(error.message, caller),
        sessions: [],
      };
    throw error;
  }
}

export async function readStoredTrace(
  cwd: string,
  sessionId: string,
  trace?: string,
  override?: TraceStorageKind,
  caller: TraceCaller = {},
) {
  try {
    // A viewer reads the saved copy only; null asks no store.
    const storage = caller.viewer
      ? null
      : await resolveTraceStorage({ cwd, override });

    const loaded = await loadReviewAgentTrace({
      cwd,
      sessionId,
      trace,
      storage,
    });

    if (!loaded)
      return {
        ok: false as const,
        status: 404 as const,
        error: `Trace not found for session ${sessionId}.`,
      };

    return {
      ok: true as const,
      parserVersion: loaded.parserVersion,
      session: loaded.descriptor,
      trace: loaded.traceName,
      cacheStatus: loaded.cacheStatus,
      subagents: loaded.subagents,
      title: loaded.trace.title,
      startedAt: loaded.trace.startedAt,
      endedAt: loaded.trace.endedAt,
      activeMs: loaded.trace.activeMs,
      userTurns: loaded.trace.userTurns,
      toolCalls: loaded.trace.toolCalls,
      events: loaded.trace.events,
    };
  } catch (error) {
    if (
      error instanceof TraceStorageDeniedError ||
      error instanceof TraceConfigurationError
    )
      return {
        ok: false as const,
        status:
          error instanceof TraceStorageDeniedError
            ? (403 as const)
            : (400 as const),
        error:
          error instanceof TraceConfigurationError
            ? configurationError(error.message, caller)
            : error.message,
      };
    throw error;
  }
}
