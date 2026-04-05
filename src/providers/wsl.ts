import { execFile, spawn } from "child_process";
import { createInterface } from "readline";
import { getPreferenceValues } from "@raycast/api";

const isWindows = process.platform === "win32";

export const WSL_PREFIX = "wsl:";

let defaultDistroPromise: Promise<string | null> | null = null;

export function wslEnabled(): boolean {
  if (!isWindows) return false;
  return !!getPreferenceValues<Preferences>().includeWsl;
}

export function getDefaultWslDistro(): Promise<string | null> {
  if (!isWindows) return Promise.resolve(null);
  if (defaultDistroPromise) return defaultDistroPromise;

  defaultDistroPromise = new Promise((resolve) => {
    execFile("wsl", ["-l"], { encoding: "utf16le", timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const lines = stdout
        .replace(/\0/g, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const defaultLine = lines.find((l) => l.includes("(Default)"));
      resolve(defaultLine ? defaultLine.replace("(Default)", "").trim() : null);
    });
  });
  return defaultDistroPromise;
}

export function buildWslKey(distro: string, dir: string): string {
  return `${WSL_PREFIX}${distro}:${dir}`;
}

export function wslUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl$\\${distro}${linuxPath.replace(/\//g, "\\")}`;
}

export function parseWslFilter(projectFilter: string | null): { distro: string; dir: string } | null {
  if (!projectFilter?.startsWith(WSL_PREFIX)) return null;
  const rest = projectFilter.slice(WSL_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return { distro: rest.slice(0, colonIdx), dir: rest.slice(colonIdx + 1) };
}

// --- Generic exec helper (for lightweight discover scripts) ---

export async function execWsl(distro: string, script: string): Promise<string> {
  if (!isWindows) return "";

  return new Promise((resolve) => {
    execFile("wsl", ["-d", distro, "-e", "sh", "-c", script], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

// --- Generic streaming scanner (for session file contents via \tFILE\t protocol) ---

export interface WslScanCallbacks {
  onFileStart(projectDir: string, sessionId: string, mtime: number): void;
  onRecord(record: Record<string, unknown>): void;
  onFileEnd(): void;
}

export async function streamWslFiles(
  distro: string,
  script: string,
  scriptArgs: string[],
  cb: WslScanCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (!isWindows) return;
  if (signal?.aborted) return;

  const args = ["-d", distro, "-e", "sh", "-c", script, "_", ...scriptArgs];

  return new Promise((resolve) => {
    const proc = spawn("wsl", args);
    const timer = setTimeout(() => proc.kill(), 30000);
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      proc.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let inFile = false;

    rl.on("line", (line) => {
      if (signal?.aborted) return;
      if (line.startsWith("\tFILE\t")) {
        if (inFile) cb.onFileEnd();
        const parts = line.split("\t");
        cb.onFileStart(parts[2], parts[3], Number(parts[4]) * 1000);
        inFile = true;
      } else if (inFile && line.trim()) {
        try {
          cb.onRecord(JSON.parse(line));
        } catch {
          /* skip malformed lines */
        }
      }
    });

    rl.on("close", () => {
      cleanup();
      if (inFile) cb.onFileEnd();
      resolve();
    });

    proc.on("error", () => {
      cleanup();
      resolve();
    });

    proc.stderr.resume();
  });
}
