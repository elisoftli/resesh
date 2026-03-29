import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import type { ProjectInfo, SessionSearchResult } from "../types";
import { collectMessage, getProjectLabel, streamJsonl } from "../utils";
import type { MessageCollector } from "../utils";
import type { SessionProvider } from "./types";

const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

function isRealUserPrompt(content: string): boolean {
  return (
    !content.startsWith("<command-name>") &&
    !content.startsWith("<command-message>") &&
    !content.startsWith("<local-command") &&
    !content.startsWith("<task-notification")
  );
}

function isUserMessage(rec: Record<string, unknown>): boolean {
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

async function readCwd(filePath: string): Promise<string | null> {
  let result: string | null = null;
  await streamJsonl(filePath, (rec, close) => {
    if (rec.cwd) {
      result = rec.cwd as string;
      close();
    }
  });
  return result;
}

async function parseSessionFile(
  filePath: string,
  sessionId: string,
  projectDir: string,
  mtime: number,
  query: string | null,
): Promise<SessionSearchResult | null> {
  let cwd: string | null = null;
  let customTitle: string | null = null;
  let gitBranch: string | null = null;
  const collector: MessageCollector = { firstUserPrompt: null, matchCount: 0, matches: [], preview: [] };
  const lowerQuery = query?.toLowerCase() ?? null;

  await streamJsonl(filePath, (rec) => {
    if (!cwd && rec.cwd) cwd = rec.cwd as string;
    if (!gitBranch && rec.gitBranch) gitBranch = rec.gitBranch as string;
    if (rec.type === "custom-title" && rec.customTitle) customTitle = rec.customTitle as string;

    if (isUserMessage(rec)) {
      collectMessage(collector, getUserContent(rec), "user", (rec.timestamp as string) ?? null, query, lowerQuery);
    }

    if (rec.type === "assistant" && Array.isArray((rec.message as Record<string, unknown>)?.content)) {
      const text = getFirstTextBlock((rec.message as { content: unknown[] }).content);
      if (text) {
        collectMessage(collector, text, "assistant", (rec.timestamp as string) ?? null, query, lowerQuery);
      }
    }
  });

  if (!cwd) return null;

  return {
    session: {
      sessionId,
      projectDir,
      projectPath: cwd,
      projectLabel: getProjectLabel(cwd),
      customTitle,
      firstUserPrompt: collector.firstUserPrompt,
      lastModified: mtime,
      gitBranch,
    },
    matchCount: collector.matchCount,
    matches: collector.matches,
    preview: collector.preview,
  };
}

async function getSessionFiles(projectDir: string): Promise<{ filePath: string; sessionId: string; mtime: number }[]> {
  const fullPath = path.join(PROJECTS_DIR, projectDir);
  let entries: Awaited<ReturnType<typeof readdir<{ withFileTypes: true }>>>;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: { filePath: string; sessionId: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl") || !entry.isFile()) continue;
    const filePath = path.join(fullPath, entry.name);
    const sessionId = entry.name.replace(".jsonl", "");
    // Use birthtime from dirent parent stat; fall back to 0 for sorting
    const { mtimeMs } = await stat(filePath).catch(() => ({ mtimeMs: 0 }));
    sessions.push({ filePath, sessionId, mtime: mtimeMs });
  }
  return sessions;
}

async function listProjectDirs(filter?: string | null): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir<{ withFileTypes: true }>>>;
  try {
    entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.filter((e) => e.isDirectory() && (!filter || e.name === filter)).map((e) => e.name);
}

export const claudeProvider: SessionProvider = {
  id: "claude",
  displayName: "Claude Code",
  assistantLabel: "Claude",
  searchPlaceholder: "Search Claude Code sessions...",
  emptyStateText: "No Claude Code sessions found in ~/.claude/projects",

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  },

  async discoverProjects(): Promise<ProjectInfo[]> {
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
  },

  async searchSessions(
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
  },
};
