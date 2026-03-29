import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { createInterface } from "readline";
import { homedir } from "os";
import path from "path";
import type { MessageSnippet, ProjectInfo, SessionSearchResult } from "./types";

const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");
const MAX_PREVIEW_TURNS = 6;

function getProjectLabel(projectPath: string): string {
  const segments = projectPath.split(/[/\\]/).filter(Boolean);
  return segments.slice(-2).join("/");
}

function isRealUserPrompt(content: string): boolean {
  return (
    !content.startsWith("<command-name>") &&
    !content.startsWith("<command-message>") &&
    !content.startsWith("<local-command") &&
    !content.startsWith("<task-notification")
  );
}

function isUserMessage(rec: Record<string, unknown>): rec is { message: { content: string }; timestamp?: string } {
  return (
    rec.type === "user" &&
    !rec.isMeta &&
    typeof (rec.message as Record<string, unknown>)?.content === "string" &&
    isRealUserPrompt((rec.message as Record<string, unknown>).content as string)
  );
}

function getUserContent(rec: Record<string, unknown>): string {
  return (rec.message as { content: string }).content;
}

function extractSnippet(text: string, query: string, windowSize = 120): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const pos = lowerText.indexOf(lowerQuery);
  if (pos === -1) return text.slice(0, windowSize * 2);

  const start = Math.max(0, pos - windowSize);
  const end = Math.min(text.length, pos + query.length + windowSize);
  let snippet = text.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

function getFirstTextBlock(content: unknown[]): string | null {
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block && "text" in block) {
      const b = block as { type: string; text: string };
      if (b.type === "text" && typeof b.text === "string") {
        return b.text;
      }
    }
  }
  return null;
}

/** Read only enough of a JSONL file to extract the cwd field, then close. */
async function readCwd(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", (line) => {
      try {
        const rec = JSON.parse(line);
        if (rec.cwd) {
          rl.close();
          resolve(rec.cwd);
        }
      } catch {
        /* skip */
      }
    });
    rl.on("close", () => resolve(null));
    rl.on("error", () => resolve(null));
  });
}

async function parseSessionFile(
  filePath: string,
  sessionId: string,
  projectDir: string,
  mtime: number,
  query: string | null,
): Promise<SessionSearchResult | null> {
  return new Promise((resolve) => {
    let cwd: string | null = null;
    let customTitle: string | null = null;
    let gitBranch: string | null = null;
    let firstUserPrompt: string | null = null;
    let matchCount = 0;
    const matches: MessageSnippet[] = [];
    const preview: MessageSnippet[] = [];
    const lowerQuery = query?.toLowerCase() ?? null;

    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

    rl.on("line", (line) => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }

      if (!cwd && rec.cwd) cwd = rec.cwd as string;
      if (!gitBranch && rec.gitBranch) gitBranch = rec.gitBranch as string;
      if (rec.type === "custom-title" && rec.customTitle) customTitle = rec.customTitle as string;

      if (isUserMessage(rec)) {
        const content = getUserContent(rec);

        if (!firstUserPrompt) firstUserPrompt = content.slice(0, 200);

        if (preview.length < MAX_PREVIEW_TURNS) {
          preview.push({ text: content.slice(0, 300), source: "user", timestamp: (rec.timestamp as string) ?? null });
        }

        if (lowerQuery && content.toLowerCase().includes(lowerQuery)) {
          matchCount++;
          matches.push({
            text: extractSnippet(content, query!),
            source: "user",
            timestamp: (rec.timestamp as string) ?? null,
          });
        }
      }

      if (rec.type === "assistant" && Array.isArray((rec.message as Record<string, unknown>)?.content)) {
        const blocks = (rec.message as { content: unknown[] }).content;
        const text = getFirstTextBlock(blocks);
        if (!text) return;

        if (preview.length < MAX_PREVIEW_TURNS) {
          preview.push({
            text: text.slice(0, 300),
            source: "assistant",
            timestamp: (rec.timestamp as string) ?? null,
          });
        }

        if (lowerQuery && text.toLowerCase().includes(lowerQuery)) {
          matchCount++;
          matches.push({
            text: extractSnippet(text, query!),
            source: "assistant",
            timestamp: (rec.timestamp as string) ?? null,
          });
        }
      }
    });

    rl.on("close", () => {
      if (!cwd) {
        resolve(null);
        return;
      }

      resolve({
        session: {
          sessionId,
          projectDir,
          projectPath: cwd,
          projectLabel: getProjectLabel(cwd),
          customTitle,
          firstUserPrompt,
          lastModified: mtime,
          gitBranch,
        },
        matchCount,
        matches,
        preview,
      });
    });

    rl.on("error", () => resolve(null));
  });
}

async function getSessionFiles(projectDir: string): Promise<{ filePath: string; sessionId: string; mtime: number }[]> {
  const fullPath = path.join(PROJECTS_DIR, projectDir);
  let entries: string[];
  try {
    entries = await readdir(fullPath);
  } catch {
    return [];
  }

  const sessions: { filePath: string; sessionId: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = path.join(fullPath, entry);
    const sessionId = entry.replace(".jsonl", "");
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        sessions.push({ filePath, sessionId, mtime: s.mtimeMs });
      }
    } catch {
      continue;
    }
  }
  return sessions;
}

async function listProjectDirs(filter?: string | null): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  if (filter) dirs = dirs.filter((d) => d === filter);

  const result: string[] = [];
  for (const dir of dirs) {
    try {
      const s = await stat(path.join(PROJECTS_DIR, dir));
      if (s.isDirectory()) result.push(dir);
    } catch {
      continue;
    }
  }
  return result;
}

export async function discoverProjects(): Promise<ProjectInfo[]> {
  const dirs = await listProjectDirs();
  const projects: ProjectInfo[] = [];

  for (const dir of dirs) {
    const fullPath = path.join(PROJECTS_DIR, dir);
    let entries: string[];
    try {
      entries = await readdir(fullPath);
    } catch {
      continue;
    }

    const firstJsonl = entries.find((e) => e.endsWith(".jsonl"));
    if (!firstJsonl) continue;

    const cwd = await readCwd(path.join(fullPath, firstJsonl));
    if (cwd) {
      projects.push({ dir, label: getProjectLabel(cwd) });
    } else {
      const segments = dir.split("-").filter(Boolean);
      projects.push({ dir, label: segments.slice(-2).join("/") });
    }
  }

  return projects.sort((a, b) => a.label.localeCompare(b.label));
}

export async function searchSessions(
  query: string,
  projectFilter: string | null,
  signal?: AbortSignal,
): Promise<SessionSearchResult[]> {
  const projectDirs = await listProjectDirs(projectFilter);
  const results: SessionSearchResult[] = [];

  for (const projectDir of projectDirs) {
    if (signal?.aborted) break;

    const sessions = await getSessionFiles(projectDir);

    for (const { filePath, sessionId, mtime } of sessions) {
      if (signal?.aborted) break;

      const parsed = await parseSessionFile(filePath, sessionId, projectDir, mtime, query || null);
      if (!parsed) continue;
      if (query && parsed.matchCount === 0) continue;

      results.push(parsed);
    }
  }

  results.sort((a, b) => b.session.lastModified - a.session.lastModified);
  return results;
}
