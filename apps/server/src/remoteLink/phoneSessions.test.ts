import { expect, it, vi } from "vitest";
import { RemotePhoneSessions } from "./phoneSessions";

it("keeps a phone connected until its last authenticated session closes", () => {
  const sessions = new RemotePhoneSessions(),
    changed = vi.fn();
  const stop = sessions.subscribe(changed);
  sessions.open("phone", "one");
  sessions.open("phone", "two");
  sessions.close("phone", "one");
  expect(sessions.connected("phone")).toBe(true);
  sessions.close("phone", "two");
  expect(sessions.connected("phone")).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
  sessions.open("phone", "three");
  expect(changed).toHaveBeenCalledTimes(2);
});
