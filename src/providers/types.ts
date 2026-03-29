import type { ProjectInfo, SessionSearchResult } from "../types";

export interface SessionProvider {
  readonly id: string;
  readonly displayName: string;
  readonly assistantLabel: string;
  readonly searchPlaceholder: string;
  readonly emptyStateText: string;

  resumeCommand(sessionId: string): string;
  discoverProjects(): Promise<ProjectInfo[]>;
  searchSessions(query: string, projectFilter: string | null, signal?: AbortSignal): Promise<SessionSearchResult[]>;
}
