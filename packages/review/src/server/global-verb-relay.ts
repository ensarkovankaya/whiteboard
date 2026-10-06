import crypto from "node:crypto";

import {
  type JsonValue,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
  parseReviewDesktopVerbResult,
  parseReviewVerbRequest,
} from "@dev.fast/review-protocol";

const DEFAULT_VERB_TIMEOUT_MS = 45_000;

const DEFAULT_MAX_CLIENTS = 16;

const DEFAULT_MAX_VIEWERS = 8;

/** What a viewer also receives: verbs that show a review and change nothing. */
const VIEWER_VERBS: ReadonlySet<string> = new Set([
  "openApiReview",
  "openReview",
  "showReviewView",
]);

const NOT_ATTACHED = "No Whiteboard Desktop is attached.";

interface PendingVerb {
  resolve(response: ReviewVerbResponse): void;
  timer: ReturnType<typeof setTimeout>;
  /** The clients yet to answer, by the frame id each was sent. */
  waiting: Map<string, GlobalReviewDesktopVerbWriter>;
  lastFailure?: ReviewVerbResponse;
}

export interface GlobalReviewDesktopVerbWriter {
  readonly signal: AbortSignal;
  write(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** The server's view of the desktop relay, so tests can supply their own. */
export interface ReviewDesktopVerbRelay {
  readonly attached: boolean;
  attach(writer: GlobalReviewDesktopVerbWriter): boolean;
  /**
   * A read-only Desktop on another machine; one per app session. The same
   * connection reattaching takes over its slot from a stream not yet noticed
   * dead.
   */
  attachViewer(
    writer: GlobalReviewDesktopVerbWriter,
    sessionId: string,
    connectionId?: string,
  ): boolean;
  dispatch(value: JsonValue): Promise<ReviewVerbResponse>;
  acceptResult(value: JsonValue): boolean;
  close(): void;
}

/**
 * Sends each verb to every attached client, each with its own frame id, and
 * resolves with the first success, or with the last failure once no client
 * is left to answer.
 */
export class GlobalReviewDesktopVerbRelay implements ReviewDesktopVerbRelay {
  private readonly clients = new Map<
    GlobalReviewDesktopVerbWriter,
    () => void
  >();
  /** Each verb in flight, under every frame id it was sent with. */
  private readonly pending = new Map<string, PendingVerb>();
  /** Viewers by app session; they hear what opens and never answer. */
  private readonly viewers = new Map<
    string,
    {
      writer: GlobalReviewDesktopVerbWriter;
      detach: () => void;
      connectionId?: string;
    }
  >();
  private readonly timeoutMs: number;
  private readonly maxClients: number;
  private readonly maxViewers: number;

  constructor(
    options: {
      timeoutMs?: number;
      maxClients?: number;
      maxViewers?: number;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VERB_TIMEOUT_MS;
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.maxViewers = options.maxViewers ?? DEFAULT_MAX_VIEWERS;
  }

  get attached(): boolean {
    return this.clients.size > 0;
  }

  attach(writer: GlobalReviewDesktopVerbWriter): boolean {
    if (
      this.clients.size >= this.maxClients ||
      this.clients.has(writer) ||
      writer.signal.aborted
    )
      return false;

    const detach = () => this.detach(writer);
    this.clients.set(writer, detach);
    writer.signal.addEventListener("abort", detach, { once: true });

    return true;
  }

  attachViewer(
    writer: GlobalReviewDesktopVerbWriter,
    sessionId: string,
    connectionId?: string,
  ): boolean {
    // A blank app session cannot tell one viewer from another.
    if (writer.signal.aborted || !sessionId.trim()) return false;

    const current = this.viewers.get(sessionId);

    if (current) {
      // Over a tunnel a dropped stream can look open for a long time; only the
      // connection that held the slot may replace it.
      if (connectionId === undefined || current.connectionId !== connectionId)
        return false;

      this.detachViewer(sessionId, current.writer);

      try {
        void Promise.resolve(current.writer.close()).catch(() => undefined);
      } catch {
        // Already closed.
      }
    } else if (this.viewers.size >= this.maxViewers) return false;

    const detach = () => this.detachViewer(sessionId, writer);
    this.viewers.set(sessionId, { writer, detach, connectionId });
    writer.signal.addEventListener("abort", detach, { once: true });

    return true;
  }

  dispatch(value: JsonValue): Promise<ReviewVerbResponse> {
    const request: ReviewVerbRequest = parseReviewVerbRequest(value);

    if (this.clients.size === 0) {
      return Promise.resolve({ ok: false, error: NOT_ATTACHED });
    }

    this.mirror(request);

    return new Promise<ReviewVerbResponse>((resolve) => {
      const verb: PendingVerb = {
        resolve,
        waiting: new Map(
          [...this.clients.keys()].map((client) => [
            crypto.randomUUID(),
            client,
          ]),
        ),
        timer: setTimeout(
          () =>
            this.settle(
              verb,
              verb.lastFailure ?? {
                ok: false,
                error: "Whiteboard Desktop verb timed out.",
              },
            ),
          this.timeoutMs,
        ),
      };

      verb.timer.unref?.();

      // Every id is registered before the first write, which may detach its
      // client at once.
      for (const id of verb.waiting.keys()) this.pending.set(id, verb);

      for (const [id, client] of [...verb.waiting]) {
        const frame = `data: ${JSON.stringify({ event: "desktop-verb", id, request })}\n\n`;

        try {
          void Promise.resolve(client.write(frame)).catch(() => {
            this.detach(client);
          });
        } catch {
          this.detach(client);
        }
      }
    });
  }

  acceptResult(value: JsonValue): boolean {
    const result = parseReviewDesktopVerbResult(value);
    const verb = this.pending.get(result.id);

    if (!verb) return false;

    if (result.response.ok) {
      this.settle(verb, result.response);
    } else {
      verb.lastFailure = result.response;
      this.stopWaiting(verb, result.id);
    }

    return true;
  }

  close(): void {
    for (const verb of new Set(this.pending.values())) {
      this.settle(verb, {
        ok: false,
        error: "Whiteboard Desktop relay closed.",
      });
    }

    for (const client of [...this.clients.keys()]) {
      this.detach(client);

      try {
        void Promise.resolve(client.close()).catch(() => undefined);
      } catch {
        // Already closed.
      }
    }

    for (const [sessionId, { writer }] of [...this.viewers]) {
      this.detachViewer(sessionId, writer);

      try {
        void Promise.resolve(writer.close()).catch(() => undefined);
      } catch {
        // Already closed.
      }
    }
  }

  private detach(writer: GlobalReviewDesktopVerbWriter): void {
    const listener = this.clients.get(writer);

    if (!listener) return;
    writer.signal.removeEventListener("abort", listener);
    this.clients.delete(writer);

    for (const [id, verb] of [...this.pending]) {
      if (verb.waiting.get(id) === writer) this.stopWaiting(verb, id);
    }
  }

  private detachViewer(
    sessionId: string,
    writer: GlobalReviewDesktopVerbWriter,
  ): void {
    const viewer = this.viewers.get(sessionId);

    if (viewer?.writer !== writer) return;
    writer.signal.removeEventListener("abort", viewer.detach);
    this.viewers.delete(sessionId);
  }

  /** Viewers get their own frame ids, which no result is ever matched against. */
  private mirror(request: ReviewVerbRequest): void {
    if (!VIEWER_VERBS.has(request.name)) return;

    for (const [sessionId, { writer }] of [...this.viewers]) {
      const frame = `data: ${JSON.stringify({ event: "desktop-verb", id: crypto.randomUUID(), request })}\n\n`;

      try {
        void Promise.resolve(writer.write(frame)).catch(() => {
          this.detachViewer(sessionId, writer);
        });
      } catch {
        this.detachViewer(sessionId, writer);
      }
    }
  }

  /** Drops one client's id; with nobody left to answer, the verb fails. */
  private stopWaiting(verb: PendingVerb, id: string): void {
    verb.waiting.delete(id);
    this.pending.delete(id);

    if (verb.waiting.size === 0)
      this.settle(verb, verb.lastFailure ?? { ok: false, error: NOT_ATTACHED });
  }

  private settle(verb: PendingVerb, response: ReviewVerbResponse): void {
    for (const id of verb.waiting.keys()) this.pending.delete(id);
    verb.waiting.clear();
    clearTimeout(verb.timer);
    verb.resolve(response);
  }
}
