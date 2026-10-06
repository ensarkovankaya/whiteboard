import { expect, it, vi } from "vitest";

import type { ReviewSession } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { captureUiEvent } from "./ui-telemetry";

const sessionWith = (readOnly: boolean) => {
  const fetch = vi.fn<ReviewSession["fetch"]>(
    async () => new Response(null, { status: 204 }),
  );

  const session: ReviewSession = {
    ...testReviewSession(),
    appSessionId: "app-session",
    readOnly,
    fetch,
  };

  return { session, fetch };
};

it("sends no UI telemetry from a read-only session", () => {
  const { session, fetch } = sessionWith(true);

  captureUiEvent(session, "scratchpad_opened");

  expect(fetch).not.toHaveBeenCalled();
});

it("posts UI telemetry from a writable session", () => {
  const { session, fetch } = sessionWith(false);

  captureUiEvent(session, "scratchpad_opened");

  expect(fetch).toHaveBeenCalledWith(
    "/telemetry/event",
    expect.objectContaining({ method: "POST" }),
  );
});
