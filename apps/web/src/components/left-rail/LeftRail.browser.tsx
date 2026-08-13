import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { CSSProperties } from "react";

import { TopBarThread } from "../middle-panel/top-bar-thread/TopBarThread";
import { DisclosureSection } from "../ui/DisclosureRegion";
import { AccountRowShared } from "./account-row-shared/AccountRowShared";
import { AccountControlShared } from "./account-control-shared/AccountControlShared";
import { FolderGroupShared } from "./folder-group-shared/FolderGroupShared";
import { FolderRowInlineEdit } from "./folder-row-inline-edit/FolderRowInlineEdit";
import { ShowMoreRow } from "./show-more-row/ShowMoreRow";
import { SidebarHeaderShared } from "./sidebar-header-shared/SidebarHeaderShared";
import { SidebarProjects } from "./sidebar-projects/SidebarProjects";
import { SidebarTopNavigation } from "./sidebar-top-navigation/SidebarTopNavigation";
import { SpaceHeaderShared } from "./space-header-shared/SpaceHeaderShared";
import { ThreadRowShared } from "./thread-row-shared/ThreadRowShared";
import { ThreadRowInlineEdit } from "./thread-row-inline-edit/ThreadRowInlineEdit";

const threads = Array.from({ length: 12 }, (_, index) => ({
  id: `thread-${index}`,
  label: `Thread ${index + 1}`,
  provider: (index % 2 === 0 ? "claudeAgent" : "codex") as "claudeAgent" | "codex",
}));

describe("Pencil left rail", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the sidebar and thread chrome on the shared 46px titlebar baseline", async () => {
    const onClose = vi.fn();
    await render(
      <div>
        <SidebarHeaderShared onClose={onClose} />
        <TopBarThread />
      </div>,
    );

    const sidebarHeader = document.querySelector<HTMLElement>("header:first-child");
    const threadHeader = document.querySelectorAll<HTMLElement>("header")[1];

    expect(sidebarHeader).not.toBeNull();
    expect(threadHeader).not.toBeNull();
    expect(sidebarHeader!.getBoundingClientRect().height).toBe(46);
    expect(threadHeader!.getBoundingClientRect().height).toBe(46);

    const brand = page.getByText("Penkra").element();
    expect(
      Math.abs(
        brand.getBoundingClientRect().left - sidebarHeader!.getBoundingClientRect().left - 18,
      ),
    ).toBeLessThan(1);

    const closeButton = page.getByRole("button", { name: "Close left panel" });
    const close = closeButton.element();
    const closeGlyph = close.querySelector<HTMLElement>("[data-slot='central-icon']");
    expect(closeGlyph).not.toBeNull();
    expect(closeGlyph!.style.mask).toContain("sidebar-simple-right-wide.svg");
    expect(
      Math.abs(
        sidebarHeader!.getBoundingClientRect().right - close.getBoundingClientRect().right - 10,
      ),
    ).toBeLessThan(1);
    await closeButton.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("replaces the close action with a back action in settings", async () => {
    const onBack = vi.fn();
    await render(<SidebarHeaderShared onBack={onBack} />);

    expect(page.getByRole("button", { name: "Close left panel" }).query()).toBeNull();
    const backButton = page.getByRole("button", { name: "Back to thread" });
    await backButton.click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("uses a real bounded vertical scroll viewport for overflowing projects", async () => {
    await render(
      <div className="h-32 w-60">
        <SidebarProjects>
          <FolderGroupShared defaultExpanded label="penkra" threads={threads} />
        </SidebarProjects>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

    viewport!.scrollTop = 40;
    viewport!.dispatchEvent(new Event("scroll"));
    expect(viewport!.scrollTop).toBeGreaterThan(0);
  });

  it("keeps folder expansion independent from header hover", async () => {
    await render(
      <>
        <FolderGroupShared label="penut" threads={threads.slice(0, 2)} />
        <button className="fixed right-0 bottom-0" type="button">
          Outside folder expansion
        </button>
      </>,
    );

    const disclosure = page.getByRole("button", { name: "penut" });
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure.element().querySelector("[data-folder-state='closed']")).toBeVisible();
    expect(disclosure.element().querySelector("[data-folder-state='open']")).not.toBeVisible();
    const rowRect = disclosure.element().getBoundingClientRect();
    const disclosureShell = document.querySelector<HTMLElement>("[data-slot='disclosure-region']");
    expect(disclosureShell).not.toBeNull();
    expect(getComputedStyle(disclosureShell!).getPropertyValue("interpolate-size")).toBe(
      "allow-keywords",
    );
    expect(getComputedStyle(disclosureShell!).transitionProperty).toBe("height");
    expect(getComputedStyle(disclosureShell!).transitionDuration).toBe("0.15s");
    expect(getComputedStyle(disclosureShell!).transitionTimingFunction).toBe("ease");
    const leadingRect = disclosure
      .element()
      .querySelector<HTMLElement>("[data-slot='left-rail-leading']")!
      .getBoundingClientRect();
    const labelRect = disclosure
      .element()
      .querySelector<HTMLElement>("[data-slot='left-rail-label']")!
      .getBoundingClientRect();
    expect(leadingRect.width).toBe(14);
    expect(Math.abs(leadingRect.left - rowRect.left - 10)).toBeLessThan(1);
    expect(Math.abs(labelRect.left - leadingRect.right - 12)).toBeLessThan(1);
    expect(Math.abs(labelRect.left - rowRect.left - 36)).toBeLessThan(1);
    await disclosure.hover();
    expect(disclosure.element().querySelector("[data-folder-state='closed']")).toBeVisible();
    expect(disclosure.element().querySelector("[data-folder-state='open']")).not.toBeVisible();
    await disclosure.click();
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(disclosure.element().querySelector("[data-folder-state='closed']")).not.toBeVisible();
    expect(disclosure.element().querySelector("[data-folder-state='open']")).toBeVisible();
    expect(disclosure.element().querySelectorAll("svg")).toHaveLength(2);
    const firstThread = page.getByRole("button", { name: "Thread 1" });
    await expect.element(firstThread).toBeVisible();
    await page.getByRole("button", { name: "Outside folder expansion" }).hover();
    await vi.waitFor(() => {
      expect(getComputedStyle(disclosure.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
    expect(
      Math.abs(
        firstThread.element().getBoundingClientRect().top -
          disclosure.element().getBoundingClientRect().bottom -
          2,
      ),
    ).toBeLessThan(1);
  });

  it("retains the last open rows until a pruned folder finishes closing", async () => {
    const renderFolder = (expanded: boolean) => (
      <FolderGroupShared
        expanded={expanded}
        hasContent
        label="Lifecycle folder"
        threads={expanded ? threads.slice(0, 2) : []}
      />
    );
    const { rerender } = await render(renderFolder(true));
    const disclosureShell = document.querySelector<HTMLElement>("[data-slot='disclosure-region']");

    expect(disclosureShell).not.toBeNull();
    await expect.element(page.getByRole("button", { name: "Thread 1" })).toBeVisible();
    await rerender(renderFolder(false));

    expect(disclosureShell!.getAttribute("aria-hidden")).toBe("true");
    expect(disclosureShell!.textContent).toContain("Thread 1");
    expect(disclosureShell!.textContent).toContain("Thread 2");

    disclosureShell!.dispatchEvent(
      new TransitionEvent("transitionend", {
        bubbles: true,
        propertyName: "height",
      }),
    );

    await vi.waitFor(() => {
      expect(disclosureShell!.textContent).not.toContain("Thread 1");
      expect(disclosureShell!.textContent).not.toContain("Thread 2");
    });
  });

  it("reverses a disclosure immediately when the user toggles it rapidly", async () => {
    const renderDisclosure = (open: boolean) => (
      <DisclosureSection hasContent header={<div>Rapid folder</div>} open={open}>
        <div>Rapid thread</div>
      </DisclosureSection>
    );
    const { rerender } = await render(renderDisclosure(true));
    const region = document.querySelector<HTMLElement>("[data-slot='disclosure-region']")!;

    await rerender(renderDisclosure(false));
    expect(region.getAttribute("aria-hidden")).toBe("true");
    expect(region.textContent).toContain("Rapid thread");

    await rerender(renderDisclosure(true));
    expect(region.getAttribute("aria-hidden")).toBeNull();
    expect(region.inert).toBe(false);
    expect(region.textContent).toContain("Rapid thread");
  });

  it("uses native button keyboard activation for folder disclosure", async () => {
    await render(<FolderGroupShared label="Keyboard folder" threads={threads.slice(0, 1)} />);
    const disclosure = page.getByRole("button", { name: "Keyboard folder" });

    disclosure.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard(" ");
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("commits an inline folder draft when an outside interaction blurs it", async () => {
    const onSubmit = vi.fn();
    await render(
      <>
        <FolderRowInlineEdit
          defaultValue="Product"
          existingNames={["Engineering"]}
          onCancel={() => undefined}
          onSubmit={onSubmit}
        />
        <div>Outside editor</div>
      </>,
    );

    const input = page.getByRole("textbox", { name: "Rename folder" });
    await input.fill("Research");
    await page.getByText("Outside editor", { exact: true }).click();
    await expect.element(input).toHaveValue("Research");
    expect(onSubmit).toHaveBeenCalledWith("Research");
  });

  it("cancels inline thread editing on Escape", async () => {
    const onCancel = vi.fn();
    await render(
      <ThreadRowInlineEdit
        defaultValue="Investigate voice"
        onCancel={onCancel}
        onSubmit={() => undefined}
      />,
    );
    await page.getByRole("textbox", { name: "Rename thread" }).fill("Unsaved draft");
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("blocks duplicate inline folder names", async () => {
    const onSubmit = vi.fn();
    await render(
      <FolderRowInlineEdit
        defaultValue="Product"
        existingNames={["Engineering"]}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    const folderInput = page.getByRole("textbox", { name: "Rename folder" });
    await folderInput.fill(" engineering ");
    await userEvent.keyboard("{Enter}");
    await expect.element(folderInput).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps an expanded folder surface distinct from its hover state", async () => {
    await render(
      <>
        <div className="w-56">
          <FolderGroupShared
            expanded
            headerState="open"
            label="Open folder"
            onHeaderAction={vi.fn()}
            threads={threads.slice(0, 1)}
          />
        </div>
        <button className="fixed right-0 bottom-0" type="button">
          Outside folder
        </button>
      </>,
    );

    await page.getByRole("button", { name: "Outside folder" }).hover();
    const folder = page.getByRole("button", { name: "Open folder", exact: true }).element();
    const action = page.getByRole("button", { name: "Create thread in Open folder" }).element();

    await vi.waitFor(() => {
      expect(getComputedStyle(folder).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
    expect(folder.querySelector("[data-folder-state='open']")).toBeVisible();
    expect(getComputedStyle(action).opacity).toBe("0");
  });

  it("keeps the folder surface highlighted and its label clear of the hovered action", async () => {
    await render(
      <div className="w-56">
        <FolderGroupShared
          label="A very long project folder name that must yield"
          onHeaderAction={vi.fn()}
          threads={threads.slice(0, 1)}
        />
      </div>,
    );

    const folder = page
      .getByRole("button", { name: "A very long project folder name that must yield", exact: true })
      .element();
    const action = page
      .getByRole("button", {
        name: "Create thread in A very long project folder name that must yield",
      })
      .element();
    const label = folder.querySelector<HTMLElement>("[data-slot='left-rail-label']")!;

    await page
      .getByRole("button", {
        name: "Create thread in A very long project folder name that must yield",
      })
      .hover();

    await vi.waitFor(() => {
      expect(getComputedStyle(folder).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(action).opacity).toBe("1");
      expect(
        action.getBoundingClientRect().left - label.getBoundingClientRect().right,
      ).toBeGreaterThanOrEqual(11);
    });
  });

  it("does not promote an active folder or reveal its create action", async () => {
    await render(
      <>
        <div className="w-56">
          <FolderGroupShared
            expanded
            headerState="active"
            label="Active folder"
            onHeaderAction={vi.fn()}
            threads={threads.slice(0, 1)}
          />
        </div>
        <button className="fixed right-0 bottom-0" type="button">
          Outside active folder
        </button>
      </>,
    );

    await page.getByRole("button", { name: "Outside active folder" }).hover();
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    const folder = page.getByRole("button", { name: "Active folder", exact: true }).element();
    const action = page.getByRole("button", { name: "Create thread in Active folder" }).element();

    expect(getComputedStyle(folder).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(action).opacity).toBe("0");
  });

  it("puts active treatment on the thread without selecting its folder", async () => {
    await render(
      <div className="w-56">
        <FolderGroupShared
          expanded
          label="Work folder"
          threads={[{ id: "active", label: "Active thread", state: "active" }]}
        />
      </div>,
    );

    const folder = page.getByRole("button", { name: "Work folder", exact: true }).element();
    const thread = page.getByRole("button", { name: "Active thread", exact: true }).element();

    expect(getComputedStyle(folder).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(thread).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("starts direct threads from Space headers rather than a global New chat row", async () => {
    await render(<SidebarTopNavigation />);

    expect(page.getByRole("button", { name: "New chat" }).query()).toBeNull();
    await expect
      .element(
        page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }),
      )
      .toBeVisible();
  });

  it("uses the Pencil root and nested thread columns", async () => {
    await render(
      <div
        className="w-56"
        style={
          {
            "--color-text-foreground": "rgb(17, 24, 39)",
            "--color-text-foreground-tertiary": "rgb(107, 114, 128)",
          } as CSSProperties & Record<`--${string}`, string>
        }
      >
        <ThreadRowShared level="root">Root thread</ThreadRowShared>
        <ThreadRowShared level="nested">Nested thread</ThreadRowShared>
        <ShowMoreRow>Show more</ShowMoreRow>
      </div>,
    );

    const root = page.getByRole("button", { name: "Root thread" }).element();
    const nested = page.getByRole("button", { name: "Nested thread" }).element();
    const showMore = page.getByRole("button", { name: "Show more" }).element();
    const rootLeading = root.querySelector<HTMLElement>("[data-slot='left-rail-leading']")!;
    const nestedLeading = nested.querySelector<HTMLElement>("[data-slot='left-rail-leading']")!;
    const rootLabel = root.querySelector<HTMLElement>("[data-slot='left-rail-label']")!;
    const nestedLabel = nested.querySelector<HTMLElement>("[data-slot='left-rail-label']")!;

    expect(
      Math.abs(rootLeading.getBoundingClientRect().left - root.getBoundingClientRect().left - 10),
    ).toBeLessThan(1);
    expect(
      Math.abs(rootLabel.getBoundingClientRect().left - root.getBoundingClientRect().left - 36),
    ).toBeLessThan(1);
    expect(
      Math.abs(
        nestedLeading.getBoundingClientRect().left - nested.getBoundingClientRect().left - 24,
      ),
    ).toBeLessThan(1);
    expect(
      Math.abs(nestedLabel.getBoundingClientRect().left - nested.getBoundingClientRect().left - 50),
    ).toBeLessThan(1);
    expect(
      Math.abs(showMore.getBoundingClientRect().left - nested.getBoundingClientRect().left),
    ).toBe(0);
    expect(getComputedStyle(showMore).paddingLeft).toBe("24px");
    expect(getComputedStyle(showMore).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    const showMoreLabel = showMore.querySelector<HTMLElement>('[data-pencil-node="k16ybr"]')!;
    const defaultLabelOpacity = getComputedStyle(showMoreLabel).opacity;
    await page.getByRole("button", { name: "Show more" }).hover({ position: { x: 220, y: 13 } });
    expect(getComputedStyle(showMore).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(showMoreLabel).opacity).toBe(defaultLabelOpacity);
    await page.elementLocator(showMoreLabel).hover();
    await vi.waitFor(() => {
      expect(getComputedStyle(showMoreLabel).opacity).not.toBe(defaultLabelOpacity);
    });
  });

  it("overlays reusable pin badges without changing thread or folder row geometry", async () => {
    await render(
      <div className="w-56">
        <ThreadRowShared pinned>Pinned thread</ThreadRowShared>
        <FolderGroupShared label="Pinned folder" pinned />
      </div>,
    );

    const thread = page.getByRole("button", { name: "Pinned thread" }).element();
    const folder = page.getByRole("button", { name: "Pinned folder" }).element();

    for (const row of [thread, folder]) {
      const leading = row.querySelector<HTMLElement>("[data-slot='left-rail-leading']")!;
      const badge = row.querySelector<HTMLElement>("[data-slot='pin-badge']")!;
      const leadingRect = leading.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();

      expect(row.dataset.pinned).toBe("true");
      expect(row.getBoundingClientRect().height).toBe(27);
      expect(leadingRect.width).toBe(14);
      expect(badgeRect.left).toBeGreaterThan(leadingRect.left + leadingRect.width / 2);
      expect(badgeRect.top).toBeGreaterThan(leadingRect.top + leadingRect.height / 2);
    }
  });

  it("reveals space affordances and shifts its title from the default edge", async () => {
    const onAction = vi.fn();
    await render(
      <>
        <div className="w-56">
          <SpaceHeaderShared onAction={onAction}>Personal</SpaceHeaderShared>
        </div>
        <button className="fixed right-0 bottom-0" type="button">
          Outside space
        </button>
      </>,
    );

    const row = page.getByRole("button", { name: "Personal", exact: true });
    const action = page.getByRole("button", { name: "Create thread in Personal" });
    await page.getByRole("button", { name: "Outside space" }).hover();
    const leading = row.element().querySelector<HTMLElement>("[data-slot='left-rail-leading']")!;
    const label = row.element().querySelector<HTMLElement>("[data-slot='left-rail-label']")!;
    const defaultRowRect = row.element().getBoundingClientRect();

    await vi.waitFor(() => {
      expect(leading.getBoundingClientRect().width).toBeCloseTo(0, 0);
      expect(getComputedStyle(action.element()).opacity).toBe("0");
    });
    const defaultLabelRect = label.getBoundingClientRect();
    expect(Math.abs(defaultLabelRect.left - defaultRowRect.left - 10)).toBeLessThan(1);
    expect(getComputedStyle(action.element()).opacity).toBe("0");
    expect(getComputedStyle(leading).transitionProperty).toContain("width");
    expect(getComputedStyle(leading).transitionDuration).toBe("0.14s");

    await row.hover();

    await vi.waitFor(() => {
      expect(leading.getBoundingClientRect().width).toBeCloseTo(14, 2);
      expect(getComputedStyle(action.element()).opacity).toBe("1");
    });
    const hoverRowRect = row.element().getBoundingClientRect();
    const hoverLeadingRect = leading.getBoundingClientRect();
    const hoverLabelRect = label.getBoundingClientRect();
    expect(hoverLeadingRect.width).toBeCloseTo(14, 2);
    expect(Math.abs(hoverLeadingRect.left - hoverRowRect.left - 10)).toBeLessThan(1);
    expect(Math.abs(hoverLabelRect.left - hoverLeadingRect.right - 12)).toBeLessThan(1);
    expect(Math.abs(hoverLabelRect.left - hoverRowRect.left - 36)).toBeLessThan(1);
    expect(getComputedStyle(label).color).toBe(getComputedStyle(row.element()).color);
    expect(getComputedStyle(action.element()).opacity).toBe("1");

    const highlightedBackground = getComputedStyle(row.element()).backgroundColor;
    await action.hover();
    expect(getComputedStyle(row.element()).backgroundColor).toBe(highlightedBackground);
    expect(getComputedStyle(leading).color).toBe(getComputedStyle(row.element()).color);
    expect(getComputedStyle(action.element()).opacity).toBe("1");

    await row.click();
    await page.getByRole("button", { name: "Outside space" }).hover();
    await vi.waitFor(() => {
      expect(leading.getBoundingClientRect().width).toBeCloseTo(0, 0);
      expect(getComputedStyle(action.element()).opacity).toBe("0");
      expect(getComputedStyle(row.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
    expect(getComputedStyle(action.element()).opacity).toBe("0");

    await row.hover();
    await action.click();
    expect(onAction).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Outside space" }).click();
    await vi.waitFor(() => {
      expect(leading.getBoundingClientRect().width).toBeCloseTo(0, 0);
      expect(getComputedStyle(action.element()).opacity).toBe("0");
    });
    expect(getComputedStyle(action.element()).opacity).toBe("0");
  });

  it("moves aggregate work status between collapsed folders and their visible threads", async () => {
    const { rerender } = await render(
      <div className="w-56">
        <FolderGroupShared
          expanded={false}
          label="Status folder"
          onHeaderAction={vi.fn()}
          threads={[{ id: "running", label: "Running thread", workStatus: "running" }]}
          workStatus="running"
        />
      </div>,
    );

    const collapsedFolder = page
      .getByRole("button", { name: "Status folder Working", exact: true })
      .element();
    expect(collapsedFolder.querySelector("[data-slot='work-status']")).not.toBeNull();
    expect(collapsedFolder.querySelector("[aria-label='Working']")).not.toBeNull();
    expect(
      document.querySelector("[data-slot='folder-content']")?.closest("[aria-hidden='true']"),
    ).not.toBeNull();

    const action = page.getByRole("button", { name: "Create thread in Status folder" });
    await action.hover();
    await vi.waitFor(() => {
      const statusRect = collapsedFolder
        .querySelector<HTMLElement>("[data-slot='work-status']")!
        .getBoundingClientRect();
      const actionRect = action.element().getBoundingClientRect();
      expect(actionRect.left - statusRect.right).toBeGreaterThanOrEqual(11);
      expect(collapsedFolder.querySelector("[aria-label='Working']")).not.toBeNull();
    });

    await rerender(
      <div className="w-56">
        <FolderGroupShared
          expanded
          label="Status folder"
          onHeaderAction={vi.fn()}
          threads={[{ id: "attention", label: "Attention thread", workStatus: "attention" }]}
          workStatus="attention"
        />
      </div>,
    );

    const openFolder = page.getByRole("button", { name: "Status folder", exact: true }).element();
    expect(openFolder.querySelector("[data-slot='work-status']")).toBeNull();
    await expect.element(page.getByRole("button", { name: /Attention thread/u })).toBeVisible();
    expect(document.querySelector("[aria-label='Needs attention']")).not.toBeNull();
  });

  it("renders the complete thread work-status lifecycle without changing row geometry", async () => {
    const { rerender } = await render(
      <div className="w-56">
        <ThreadRowShared workStatus="idle">Lifecycle thread</ThreadRowShared>
      </div>,
    );

    const row = page.getByRole("button", { name: "Lifecycle thread" });
    const initialRect = row.element().getBoundingClientRect();
    expect(row.element().querySelector("[data-slot='thread-status']")).toBeNull();

    for (const [workStatus, label] of [
      ["running", "Working"],
      ["done", "Done"],
      ["attention", "Needs attention"],
      ["recording", "Recording voice"],
    ] as const) {
      await rerender(
        <div className="w-56">
          <ThreadRowShared workStatus={workStatus}>Lifecycle thread</ThreadRowShared>
        </div>,
      );
      const current = page.getByRole("button", { name: "Lifecycle thread" }).element();
      expect(current.querySelector(`[aria-label='${label}']`)).not.toBeNull();
      expect(current.getBoundingClientRect().width).toBe(initialRect.width);
      expect(current.getBoundingClientRect().height).toBe(initialRect.height);
    }

    const recordingIcon = page.getByLabelText("Recording voice").element();
    expect(recordingIcon.classList.contains("animate-pulse")).toBe(true);
    expect(recordingIcon.classList.contains("animate-spin")).toBe(false);
  });

  it("keeps an empty shared disclosure at zero layout height", async () => {
    const { rerender } = await render(
      <div className="flex flex-col gap-0.5">
        <DisclosureSection
          hasContent={false}
          header={<div className="h-[27px]" data-slot="empty-disclosure-header" />}
          open={false}
        >
          <div className="h-[27px]" data-slot="empty-disclosure-content" />
        </DisclosureSection>
        <div className="h-[27px]" data-slot="empty-disclosure-sibling" />
      </div>,
    );

    const sibling = document.querySelector<HTMLElement>("[data-slot='empty-disclosure-sibling']")!;
    const siblingTop = sibling.getBoundingClientRect().top;

    await rerender(
      <div className="flex flex-col gap-0.5">
        <DisclosureSection
          hasContent={false}
          header={<div className="h-[27px]" data-slot="empty-disclosure-header" />}
          open
        >
          <div className="h-[27px]" data-slot="empty-disclosure-content" />
        </DisclosureSection>
        <div className="h-[27px]" data-slot="empty-disclosure-sibling" />
      </div>,
    );

    expect(document.querySelector("[data-slot='empty-disclosure-content']")).toBeNull();
    expect(sibling.getBoundingClientRect().top).toBe(siblingTop);
  });

  it("keeps an empty folder closed without moving the next row", async () => {
    await render(
      <div className="flex flex-col gap-0.5">
        <FolderGroupShared label="Empty folder" />
        <div className="h-[27px]" data-slot="empty-folder-sibling" />
      </div>,
    );

    const disclosure = page.getByRole("button", { name: "Empty folder" });
    const sibling = document.querySelector<HTMLElement>("[data-slot='empty-folder-sibling']")!;
    const siblingTop = sibling.getBoundingClientRect().top;

    await disclosure.click();

    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure.element().querySelector("[data-folder-state='closed']")).toBeVisible();
    expect(disclosure.element().querySelector("[data-folder-state='open']")).not.toBeVisible();
    expect(document.querySelector("[data-slot='folder-content']")).toBeNull();
    expect(sibling.getBoundingClientRect().top).toBe(siblingTop);
  });

  it("keeps account and help as separate actions", async () => {
    const onAccount = vi.fn();
    const onHelp = vi.fn();
    await render(<AccountRowShared name="gigsama" onAccount={onAccount} onHelp={onHelp} />);

    await page.getByRole("button", { name: "gigsama" }).click();
    await page.getByRole("button", { name: "Help" }).click();

    expect(onAccount).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(page.getByRole("button", { name: "Settings" }).query()).toBeNull();
  });

  it("keeps the account row surface transparent on hover", async () => {
    await render(<AccountRowShared name="gigsama" />);

    await page.getByRole("button", { name: "gigsama" }).hover();
    const row = document.querySelector<HTMLElement>(".group\\/account-row");
    const help = document.querySelector<HTMLElement>("button[aria-label='Help']");

    expect(row).not.toBeNull();
    expect(help).not.toBeNull();
    expect(getComputedStyle(row!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps an available update independent from the account menu", async () => {
    const onAccount = vi.fn();
    const onUpdate = vi.fn();
    await render(
      <AccountRowShared
        name="gigsama"
        onAccount={onAccount}
        onUpdate={onUpdate}
        updateLabel="Update"
        updatePhase="ready"
      />,
    );

    await page.getByRole("button", { name: "Update" }).click();

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onAccount).not.toHaveBeenCalled();
  });

  it("matches the Pencil lifecycle treatments without changing account-row geometry", async () => {
    const { rerender } = await render(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="Preparing…"
        updatePhase="preparing"
      />,
    );

    const preparing = page.getByRole("button", { name: "Preparing…" });
    const row = preparing.element().closest<HTMLElement>(".h-11");
    await expect.element(preparing).toBeDisabled();
    expect(preparing.element().querySelector(".animate-spin")).not.toBeNull();
    expect(page.getByRole("button", { name: "Help" }).query()).toBeNull();

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="42%"
        updatePhase="downloading"
      />,
    );
    const downloading = page.getByRole("button", { name: "42%" });
    await expect.element(downloading).toBeDisabled();
    expect(downloading.element().querySelector(".animate-spin")).toBeNull();
    const neutralUpdateBackground = getComputedStyle(downloading.element()).backgroundColor;

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateLabel="Update"
        updatePhase="ready"
      />,
    );
    const ready = page.getByRole("button", { name: "Update" });
    await expect.element(ready).toBeEnabled();
    expect(ready.element().getBoundingClientRect().height).toBe(26);
    expect(getComputedStyle(ready.element()).backgroundColor).not.toBe(neutralUpdateBackground);

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="Updating…"
        updatePhase="installing"
      />,
    );
    const installing = page.getByRole("button", { name: "Updating…" });
    await expect.element(installing).toBeDisabled();
    expect(installing.element().querySelector(".animate-spin")).not.toBeNull();
    expect(row?.getBoundingClientRect().height).toBe(44);
    expect(row?.getBoundingClientRect().width).toBe(240);
    expect(page.getByRole("button", { name: "Help" }).query()).toBeNull();
  });

  it("opens Settings directly from the account row", async () => {
    const onSettings = vi.fn();
    await render(
      <div className="flex h-64 items-end">
        <AccountControlShared accountName="gigsama" onSettings={onSettings} />
      </div>,
    );

    const trigger = page.getByRole("button", { name: "gigsama" });
    await trigger.click();

    expect(onSettings).toHaveBeenCalledOnce();
    const row = document.querySelector<HTMLElement>(".group\\/account-row");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-selected")).toBeNull();
    expect(row!.getBoundingClientRect().height).toBe(44);
    expect(getComputedStyle(row!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(document.querySelector("[data-slot='menu-popup']")).toBeNull();
  });
});
