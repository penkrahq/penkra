import "../../../../index.css";

import { SpaceId } from "@penkra/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => null,
}));

import { useStore } from "~/store";
import { SettingsSpacesPage } from "./SettingsSpacesPage";

const timestamp = "2026-08-09T00:00:00.000Z";
const personalSpaceId = SpaceId.makeUnsafe("space-personal");

describe("Settings Spaces", () => {
  beforeEach(() => {
    useStore.setState({
      spaces: [
        {
          id: personalSpaceId,
          name: "Personal",
          icon: "home",
          sortOrder: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      archivedSpaces: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("shows Space organization without Connection defaults", async () => {
    await render(<SettingsSpacesPage />);

    await expect.element(page.getByLabelText("Personal Space")).toBeVisible();
    await expect.element(page.getByText("0 Folders · 0 Threads")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /default Connection/ }))
      .not.toBeInTheDocument();
  });
});
