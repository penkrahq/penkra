import { describe, expect, it } from "vitest";
import { extractExportedHookTopology } from "./viteReactRefreshGuard";

describe("extractExportedHookTopology", () => {
  it("ignores modules without an exported custom hook", () => {
    expect(extractExportedHookTopology("export function helper() {}")).toBeNull();
  });

  it("tracks hook order, including TypeScript generic calls", () => {
    expect(
      extractExportedHookTopology(`
        export function usePager() {
          const viewport = useRef<HTMLDivElement | null>(null);
          useEffect(() => {}, []);
          return viewport;
        }
      `),
    ).toBe("usePager|useRef|useEffect");
  });

  it("changes when a hook is added or reordered", () => {
    const before = extractExportedHookTopology(`
      export const usePager = () => {
        useRef(null);
        useEffect(() => {}, []);
      };
    `);
    const after = extractExportedHookTopology(`
      export const usePager = () => {
        useRef(null);
        useCallback(() => {}, []);
        useEffect(() => {}, []);
      };
    `);

    expect(after).not.toBe(before);
  });

  it("does not change for an implementation-only edit", () => {
    const before = extractExportedHookTopology(`
      export function usePager() {
        const value = useMemo(() => 1, []);
        return value;
      }
    `);
    const after = extractExportedHookTopology(`
      export function usePager() {
        const value = useMemo(() => 2, []);
        return value;
      }
    `);

    expect(after).toBe(before);
  });
});
