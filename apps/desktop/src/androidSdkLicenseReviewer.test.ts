import ChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { DefaultAndroidSdkLicenseReviewer } from "./androidSdkLicenseReviewer";

describe("DefaultAndroidSdkLicenseReviewer", () => {
  it("shows and answers every official SDK Manager prompt explicitly", async () => {
    const prompt = vi.fn(async () => true);
    const reviewer = new DefaultAndroidSdkLicenseReviewer({
      spawn: () =>
        ChildProcess.spawn(
          process.execPath,
          ["-e", "process.stdout.write('All SDK package licenses accepted.\\n')"],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
    });
    await reviewer.review({
      executable: "/sdkmanager",
      signal: new AbortController().signal,
      prompt,
    });

    expect(prompt).not.toHaveBeenCalled();
  });

  it("answers multiple prompts only after trusted acceptance", async () => {
    const prompts: string[] = [];
    const reviewer = new DefaultAndroidSdkLicenseReviewer({
      spawn: () =>
        ChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "let n=0,b=''; const ask=()=>process.stdout.write('License '+(++n)+' terms\\nAccept? (y/N): '); ask(); process.stdin.on('data',c=>{b+=c; if(!b.includes('\\n'))return; const answer=b.trim(); b=''; if(answer!=='y')process.exit(5); if(n===2)process.exit(0); ask();});",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
    });
    await reviewer.review({
      executable: "/sdkmanager",
      signal: new AbortController().signal,
      prompt: async (value) => {
        prompts.push(value.text);
        return true;
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("License 1 terms");
    expect(prompts[1]).toContain("License 2 terms");
  });

  it("enters review mode without treating it as license acceptance", async () => {
    const prompts: string[] = [];
    const reviewer = new DefaultAndroidSdkLicenseReviewer({
      spawn: () =>
        ChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "let b=''; process.stdout.write('2 of 2 SDK package licenses not accepted.\\nReview licenses that have not been accepted (y/N)? '); process.stdin.on('data',c=>{b+=c; if(!b.includes('\\n'))return; const answer=b.trim(); b=''; if(answer!=='y')process.exit(6); process.stdout.write('Official license terms\\nAccept? (y/N): ');});",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
    });

    await expect(
      reviewer.review({
        executable: "/sdkmanager",
        signal: new AbortController().signal,
        prompt: async (value) => {
          prompts.push(value.text);
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: "SETUP_CANCELLED" });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Official license terms");
    expect(prompts[0]).not.toContain("Review licenses that have not been accepted");
  });

  it("stops setup as a cancellation when the user leaves license review", async () => {
    const reviewer = new DefaultAndroidSdkLicenseReviewer({
      spawn: () =>
        ChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write('License terms\\nAccept? (y/N): '); setInterval(()=>{},1000)",
          ],
          { detached: true, stdio: ["pipe", "pipe", "pipe"] },
        ),
    });

    await expect(
      reviewer.review({
        executable: "/sdkmanager",
        signal: new AbortController().signal,
        prompt: async () => false,
      }),
    ).rejects.toMatchObject({ code: "SETUP_CANCELLED" });
  });

  it("cancels and cleans up SDK Manager while awaiting input", async () => {
    const controller = new AbortController();
    const reviewer = new DefaultAndroidSdkLicenseReviewer({
      spawn: () =>
        ChildProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    const review = reviewer.review({
      executable: "/sdkmanager",
      signal: controller.signal,
      prompt: async () => true,
    });
    controller.abort();

    await expect(review).rejects.toMatchObject({ code: "SETUP_CANCELLED" });
  });
});
