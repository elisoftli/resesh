import { Color, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { SessionActions } from "./actions";
import { discoverProjects, searchSessions } from "./sessions";
import type { MessageSnippet, SessionSearchResult } from "./types";

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function groupByProject(results: SessionSearchResult[]): Map<string, SessionSearchResult[]> {
  const groups = new Map<string, SessionSearchResult[]>();
  for (const r of results) {
    const key = r.session.projectDir;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return groups;
}

function sessionTitle(result: SessionSearchResult): string {
  if (result.session.customTitle) return result.session.customTitle;
  if (result.session.firstUserPrompt) {
    const prompt = result.session.firstUserPrompt.replace(/\n/g, " ").trim();
    return prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
  }
  return result.session.sessionId.slice(0, 8);
}

function formatTime(timestamp: string | null): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function snippetToMarkdown(msg: MessageSnippet): string {
  const label = msg.source === "user" ? "You" : "Claude";
  const time = formatTime(msg.timestamp);
  const header = time ? `**${label}** \u00a0\u00b7\u00a0 \`${time}\`` : `**${label}**`;
  return `${header}\n\n> ${msg.text.replace(/\n/g, "\n> ")}`;
}

function sessionDetailMarkdown(result: SessionSearchResult, isSearching: boolean): string {
  if (isSearching && result.matches.length > 0) {
    const header = `### ${result.matches.length} Match${result.matches.length > 1 ? "es" : ""}\n\n`;
    return header + result.matches.map(snippetToMarkdown).join("\n\n---\n\n");
  }

  if (result.preview.length > 0) {
    return result.preview.map(snippetToMarkdown).join("\n\n---\n\n");
  }

  return "*No content available*";
}

export default function SearchSessionCommand() {
  const [searchText, setSearchText] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const debouncedQuery = useDebouncedValue(searchText, 300);
  const isSearching = debouncedQuery.length > 0;

  const { data: projects } = usePromise(discoverProjects);

  const abortable = useRef<AbortController>();
  const { data: results, isLoading } = usePromise(
    searchSessions,
    [debouncedQuery, projectFilter === "all" ? null : projectFilter],
    { abortable },
  );

  const grouped = useMemo(() => (results ? groupByProject(results) : new Map()), [results]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search Claude Code sessions..."
      filtering={false}
      throttle
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by Project" value={projectFilter} onChange={setProjectFilter}>
          <List.Dropdown.Item title="All Projects" value="all" icon={Icon.AppWindowGrid3x3} />
          <List.Dropdown.Section title="Projects">
            {projects?.map((p) => (
              <List.Dropdown.Item key={p.dir} title={p.label} value={p.dir} icon={Icon.Folder} />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {results?.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title="No sessions found"
          description={
            searchText ? "Try a different search term" : "No Claude Code sessions found in ~/.claude/projects"
          }
        />
      ) : (
        Array.from(grouped.entries()).map(([projectDir, items]) => (
          <List.Section
            key={projectDir}
            title={items[0].session.projectLabel}
            subtitle={`${items.length} session${items.length > 1 ? "s" : ""}`}
          >
            {items.map((result) => (
              <List.Item
                key={result.session.sessionId}
                icon={{ source: Icon.Terminal, tintColor: Color.SecondaryText }}
                title={sessionTitle(result)}
                detail={<List.Item.Detail markdown={sessionDetailMarkdown(result, isSearching)} />}
                actions={<SessionActions session={result.session} />}
              />
            ))}
          </List.Section>
        ))
      )}
    </List>
  );
}
