import { Button } from "@canvas/ui/button";
import { StatusBanner } from "@canvas/ui/status-banner";
import { type ReactElement, useState } from "react";

import { useReviewSession } from "./host/review-session";
import { useReviewActions, useReviewState } from "./review-context";

export function MissingCheckoutBanner({
  worktree,
}: {
  worktree: boolean;
}): ReactElement {
  const { dismissReview } = useReviewActions();
  const { submissionOutcome } = useReviewState();
  // A viewer reads another machine's review and cannot dismiss it.
  const readOnly = useReviewSession().readOnly === true;
  const [busy, setBusy] = useState(false);

  return (
    <StatusBanner
      action={
        !submissionOutcome &&
        !readOnly && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);

              try {
                await dismissReview();
              } catch (error) {
                console.error("Review action failed", error);
                setBusy(false);
              }
            }}
          >
            Dismiss review
          </Button>
        )
      }
    >
      {worktree
        ? "This review's worktree was removed."
        : "Local checkout unavailable."}{" "}
      Showing the source saved with the review.
    </StatusBanner>
  );
}
