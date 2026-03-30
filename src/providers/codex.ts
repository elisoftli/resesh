import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import type { ProjectInfo, SessionSearchResult } from "../types";
import { collectMessage, getProjectLabel, streamJsonl } from "../utils";
import type { MessageCollector } from "../utils";
import type { SessionProvider } from "./types";

const SESSIONS_DIR = path.join(homedir(), ".codex", "sessions");
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function sessionIdFromFilename(filename: string): string {
  const m = UUID_RE.exec(filename);
  return m ? m[1] : filename.replace(".jsonl", "");
}

async function findSessionFiles(baseDir: string): Promise<{ filePath: string; sessionId: string; mtime: number }[]> {
  const sessions: { filePath: string; sessionId: string; mtime: number }[] = [];

  async function walk(dir: string) {
    let entries: Awaited<ReturnType<typeof readdir<{ withFileTypes: true }>>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(".jsonl") && entry.isFile()) {
        const { mtimeMs } = await stat(fullPath).catch(() => ({ mtimeMs: 0 }));
        sessions.push({ filePath: fullPath, sessionId: sessionIdFromFilename(entry.name), mtime: mtimeMs });
      }
    }
  }

  await walk(baseDir);
  return sessions;
}

function isUserMessage(rec: Record<string, unknown>): boolean {
  if (rec.type !== "event_msg") return false;
  const payload = rec.payload as Record<string, unknown> | undefined;
  return payload?.type === "user_message" && typeof payload?.message === "string";
}

function isAgentMessage(rec: Record<string, unknown>): boolean {
  if (rec.type !== "event_msg") return false;
  const payload = rec.payload as Record<string, unknown> | undefined;
  return payload?.type === "agent_message" && typeof payload?.message === "string";
}

async function parseSessionFile(
  filePath: string,
  filenameSessionId: string,
  mtime: number,
  query: string | null,
  projectFilter: string | null,
): Promise<SessionSearchResult | null> {
  let sessionId = filenameSessionId;
  let cwd: string | null = null;
  const collector: MessageCollector = { firstUserPrompt: null, matchCount: 0, matches: [], preview: [] };
  const lowerQuery = query?.toLowerCase() ?? null;
  let rejected = false;

  await streamJsonl(filePath, (rec, close) => {
    if (rejected) return;

    if (rec.type === "session_meta") {
      const payload = rec.payload as Record<string, unknown> | undefined;
      if (payload?.cwd) cwd = payload.cwd as string;
      if (payload?.id) sessionId = payload.id as string;

      // Early exit if this session doesn't match the project filter
      if (projectFilter && cwd !== projectFilter) {
        rejected = true;
        close();
        return;
      }
    }

    if (isUserMessage(rec)) {
      const content = (rec.payload as { message: string }).message;
      collectMessage(collector, content, "user", (rec.timestamp as string) ?? null, query, lowerQuery);
    }

    if (isAgentMessage(rec)) {
      const content = (rec.payload as { message: string }).message;
      collectMessage(collector, content, "assistant", (rec.timestamp as string) ?? null, query, lowerQuery);
    }
  });

  if (!cwd || rejected) return null;

  return {
    session: {
      sessionId,
      projectDir: cwd,
      projectPath: cwd,
      projectLabel: getProjectLabel(cwd),
      customTitle: null,
      firstUserPrompt: collector.firstUserPrompt,
      lastModified: mtime,
      gitBranch: null,
    },
    matchCount: collector.matchCount,
    matches: collector.matches,
    preview: collector.preview,
  };
}

export const codexProvider: SessionProvider = {
  id: "codex",
  displayName: "Codex CLI",
  assistantLabel: "Codex",
  searchPlaceholder: "Search Codex CLI sessions...",
  emptyStateText: "No Codex CLI sessions found in ~/.codex/sessions",

  resumeCommand(sessionId: string): string {
    return `codex resume ${sessionId}`;
  },

  async discoverProjects(): Promise<ProjectInfo[]> {
    const sessions = await findSessionFiles(SESSIONS_DIR);
    const projectMap = new Map<string, string>();

    for (const { filePath } of sessions) {
      let cwd: string | null = null;
      await streamJsonl(filePath, (rec, close) => {
        if (rec.type === "session_meta") {
          const payload = rec.payload as Record<string, unknown> | undefined;
          if (payload?.cwd) {
            cwd = payload.cwd as string;
            close();
          }
        }
      });
      if (cwd && !projectMap.has(cwd)) {
        projectMap.set(cwd, getProjectLabel(cwd));
      }
    }

    const projects: ProjectInfo[] = [];
    for (const [dir, label] of projectMap) {
      projects.push({ dir, label });
    }

    return projects.sort((a, b) => a.label.localeCompare(b.label));
  },

  async searchSessions(
    query: string,
    projectFilter: string | null,
    signal?: AbortSignal,
  ): Promise<SessionSearchResult[]> {
    const allFiles = await findSessionFiles(SESSIONS_DIR);
    const results: SessionSearchResult[] = [];

    for (const { filePath, sessionId, mtime } of allFiles) {
      if (signal?.aborted) break;

      const parsed = await parseSessionFile(filePath, sessionId, mtime, query || null, projectFilter);
      if (!parsed) continue;
      if (query && parsed.matchCount === 0) continue;

      results.push(parsed);
    }

    results.sort((a, b) => b.session.lastModified - a.session.lastModified);
    return results;
  },
};
