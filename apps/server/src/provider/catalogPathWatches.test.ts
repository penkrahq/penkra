import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CatalogPathWatches } from "./catalogPathWatches.ts";

function harness() {
  let present = false;
  const handles: {
    root: { path: string; recursive: boolean };
    close: ReturnType<typeof vi.fn>;
    change: (event: string, filename: string | null) => void;
    error: ((error: Error) => void) | undefined;
  }[] = [];
  const pool = new CatalogPathWatches(
    (target) => (present ? { path: target, recursive: true } : { path: "/home", recursive: false }),
    (root, change) => {
      const handle = {
        root,
        change,
        close: vi.fn(),
        error: undefined as ((error: Error) => void) | undefined,
      };
      handles.push(handle);
      return {
        close: handle.close,
        on: (_event, listener) => {
          handle.error = listener;
        },
      };
    },
  );
  return {
    pool,
    handles,
    setPresent: () => {
      present = true;
    },
  };
}

describe("catalog path watches", () => {
  it("checks every missing ancestor before choosing an existing watch root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "catalog-watch-ancestors-"));
    const opened = vi.fn(() => ({ close: vi.fn(), on: vi.fn() }));
    const pool = new CatalogPathWatches(undefined, opened);
    try {
      pool.add([path.join(root, "missing", ".agents", "skills")], vi.fn(), vi.fn());
      expect(opened).toHaveBeenCalledExactlyOnceWith(
        { path: root, recursive: false },
        expect.any(Function),
      );
    } finally {
      pool.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("shares a source watch and closes it only after the final scope releases it", () => {
    const { pool, handles } = harness();
    const a = vi.fn(),
      b = vi.fn();
    const releaseA = pool.add(["/home/.claude/skills"], a, vi.fn());
    const releaseB = pool.add(["/home/.claude/skills"], b, vi.fn());
    expect(handles).toHaveLength(1);
    handles[0]!.change("change", ".claude");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    releaseA();
    expect(handles[0]!.close).not.toHaveBeenCalled();
    releaseB();
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("watches only the missing path's parent until creation, then the actual directory", () => {
    const { pool, handles, setPresent } = harness();
    const changed = vi.fn();
    pool.add(["/home/.claude/skills"], changed, vi.fn());
    expect(handles[0]!.root).toEqual({ path: "/home", recursive: false });
    handles[0]!.change("rename", "unrelated");
    expect(changed).not.toHaveBeenCalled();
    setPresent();
    handles[0]!.change("rename", ".claude");
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(handles[1]!.root).toEqual({ path: "/home/.claude/skills", recursive: true });
    handles[1]!.change("change", "review/SKILL.md");
    expect(changed).toHaveBeenCalledTimes(2);
    pool.close();
  });

  it("reports a watch failure without retrying or retaining an open handle", () => {
    const { pool, handles } = harness();
    const failed = vi.fn();
    const release = pool.add(["/home/.claude/agents"], vi.fn(), failed);
    const error = new Error("watch unavailable");
    handles[0]!.error!(error);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(handles).toHaveLength(1);
    release();
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });
});
