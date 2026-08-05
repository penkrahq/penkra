export type ReplaceAppInput = {
  source: string;
  target: string;
  backupLabel?: string;
  timestamp?: string;
  staging?: string;
  exists?: (path: string) => boolean;
  copy?: (source: string, target: string) => void;
  rename?: (source: string, target: string) => void;
  remove?: (path: string) => void;
  verify: (path: string) => void;
};

export function replaceAppAtomically(input: ReplaceAppInput): { backup: string | null };

export type RelaunchProcess = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore" },
) => { unref(): void };

export function schedulePenkraRelaunch(target: string, spawnProcess?: RelaunchProcess): void;

export function installLocalRelease(artifactDir?: string): void;
