// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FinancialActionAnnouncementRegion,
  useFinancialActionAnnouncement,
} from "../src/components/financial-action-announcement";

function AnnouncementHarness() {
  const { announcement, announce } = useFinancialActionAnnouncement();

  return (
    <>
      <FinancialActionAnnouncementRegion announcement={announcement} />
      <button
        onClick={() =>
          announce({
            actionId: "job-1",
            label: "Service payment",
            outcome: "submitted",
          })
        }
      >
        Submit
      </button>
      <button
        onClick={() =>
          announce({
            actionId: "job-2",
            label: "Service payment",
            outcome: "submitted",
          })
        }
      >
        Submit another
      </button>
      <button
        onClick={() =>
          announce({
            actionId: "job-1",
            label: "Service payment",
            outcome: "confirmed",
          })
        }
      >
        Confirm
      </button>
      <button
        onClick={() =>
          announce({
            actionId: "job-1",
            label: "Service payment",
            outcome: "failed",
          })
        }
      >
        Replay stale poll
      </button>
      <button
        onClick={() =>
          announce({
            actionId: "job-2",
            label: "Revenue distribution",
            outcome: "failed",
          })
        }
      >
        Fail
      </button>
    </>
  );
}

describe("financial action announcements", () => {
  it("announces submitted and confirmed once despite repeated or stale polling results", () => {
    render(<AnnouncementHarness />);
    const liveRegion = screen.getByRole("status");

    fireEvent.click(screen.getByText("Submit"));
    expect(liveRegion.textContent).toBe("Service payment submitted.");
    fireEvent.click(screen.getByText("Submit"));
    expect(liveRegion.textContent).toBe("Service payment submitted.");

    fireEvent.click(screen.getByText("Confirm"));
    expect(liveRegion.textContent).toBe("Service payment confirmed.");

    fireEvent.click(screen.getByText("Confirm"));
    fireEvent.click(screen.getByText("Submit"));
    fireEvent.click(screen.getByText("Replay stale poll"));
    expect(liveRegion.textContent).toBe("Service payment confirmed.");
  });

  it("announces failure for a separate action attempt", () => {
    render(<AnnouncementHarness />);

    fireEvent.click(screen.getByText("Fail"));

    expect(screen.getByRole("status").textContent).toBe(
      "Revenue distribution failed.",
    );
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("creates a fresh live-region message for a new action with the same wording", () => {
    render(<AnnouncementHarness />);
    const liveRegion = screen.getByRole("status");

    fireEvent.click(screen.getByText("Submit"));
    const firstMessage = liveRegion.firstElementChild;
    fireEvent.click(screen.getByText("Submit another"));

    expect(liveRegion.textContent).toBe("Service payment submitted.");
    expect(liveRegion.firstElementChild).not.toBe(firstMessage);
  });
});
