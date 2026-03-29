import {
  Action,
  ActionPanel,
  Clipboard,
  getPreferenceValues,
  Icon,
  showInFinder,
  showToast,
  Toast,
} from "@raycast/api";
import { exec, execFile } from "child_process";
import type { SessionInfo } from "./types";

interface Preferences {
  terminal: string;
  ide: string;
}

const isMac = process.platform === "darwin";

const MAC_ONLY_TERMINALS = new Set(["terminal", "iterm", "ghostty", "kitty"]);
const WIN_ONLY_TERMINALS = new Set(["wt", "powershell", "cmd"]);

function resolveTerminal(pref: string): string {
  if (pref === "default") return isMac ? "terminal" : "wt";

  if (isMac && WIN_ONLY_TERMINALS.has(pref)) {
    showToast({ style: Toast.Style.Failure, title: `${pref} is not available on macOS, using Terminal.app` });
    return "terminal";
  }
  if (!isMac && MAC_ONLY_TERMINALS.has(pref)) {
    showToast({ style: Toast.Style.Failure, title: `${pref} is not available on Windows, using Windows Terminal` });
    return "wt";
  }

  return pref;
}

const IDE_APPS: Record<string, string> = {
  vscode: "Visual Studio Code",
  cursor: "Cursor",
  zed: "Zed",
  webstorm: "WebStorm",
  intellij: "IntelliJ IDEA",
};

function toastOnError(label: string) {
  return (error: Error | null) => {
    if (error) {
      showToast({ style: Toast.Style.Failure, title: `Failed to open ${label}`, message: error.message });
    }
  };
}

function escapeShellArg(s: string): string {
  if (isMac) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return `"${s.replace(/"/g, '\\"')}"`;
}

function bashCommand(dir: string, resumeCmd: string): string {
  const escapedDir = dir.replace(/'/g, "'\\''");
  return `export PATH="$HOME/.local/bin:$PATH" && cd '${escapedDir}' && ${resumeCmd}`;
}

function macAppleScriptLaunch(appName: string, session: SessionInfo, resumeCmd: string) {
  const cmd = bashCommand(session.projectPath, resumeCmd);
  const script = `tell application "${appName}"
  activate
  do script "${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
end tell`;
  execFile("osascript", ["-e", script], toastOnError(appName));
}

function openInTerminal(session: SessionInfo, resumeCmd: string) {
  const prefs = getPreferenceValues<Preferences>();
  const terminal = resolveTerminal(prefs.terminal ?? "default");
  const dir = session.projectPath;
  const bashCmd = bashCommand(dir, resumeCmd);

  if (isMac) {
    switch (terminal) {
      case "terminal":
      case "iterm":
      case "warp":
        macAppleScriptLaunch(
          terminal === "terminal" ? "Terminal" : terminal === "iterm" ? "iTerm" : "Warp",
          session,
          resumeCmd,
        );
        return;
      case "ghostty":
        execFile(
          "/Applications/Ghostty.app/Contents/MacOS/ghostty",
          ["-e", "/bin/bash", "-lc", bashCmd],
          toastOnError("Ghostty"),
        );
        return;
      case "kitty":
        execFile(
          "kitty",
          ["--single-instance", "--directory", dir, "/bin/bash", "-lc", bashCmd],
          toastOnError("Kitty"),
        );
        return;
      case "alacritty":
        execFile(
          "alacritty",
          ["--working-directory", dir, "-e", "/bin/bash", "-lc", bashCmd],
          toastOnError("Alacritty"),
        );
        return;
      case "wezterm":
        execFile("wezterm", ["start", "--cwd", dir, "--", "/bin/bash", "-lc", bashCmd], toastOnError("WezTerm"));
        return;
    }
  } else {
    const winDir = dir.replace(/\//g, "\\");
    const cmd = resumeCmd;
    switch (terminal) {
      case "wt":
        exec(`wt.exe -d ${escapeShellArg(winDir)} cmd /k "${cmd}"`, toastOnError("Windows Terminal"));
        return;
      case "powershell":
        exec(
          `start powershell -NoExit -Command "Set-Location ${escapeShellArg(winDir)}; ${cmd}"`,
          toastOnError("PowerShell"),
        );
        return;
      case "cmd":
        exec(`start cmd /k "cd /d ${winDir} && ${cmd}"`, toastOnError("Command Prompt"));
        return;
      case "warp":
        exec(
          `warp-terminal.exe --working-directory ${escapeShellArg(winDir)} -e cmd /k "${cmd}"`,
          toastOnError("Warp"),
        );
        return;
      case "alacritty":
        exec(`alacritty --working-directory ${escapeShellArg(winDir)} -e cmd /k "${cmd}"`, toastOnError("Alacritty"));
        return;
      case "wezterm":
        exec(`wezterm start --cwd ${escapeShellArg(winDir)} -- cmd /k "${cmd}"`, toastOnError("WezTerm"));
        return;
    }
  }
}

function openInIDE(session: SessionInfo) {
  const prefs = getPreferenceValues<Preferences>();
  const appName = IDE_APPS[prefs.ide] ?? "Visual Studio Code";

  if (isMac) {
    execFile("open", ["-a", appName, session.projectPath], toastOnError(appName));
  } else {
    exec(`start "" "${appName}" "${session.projectPath.replace(/\//g, "\\")}"`, toastOnError(appName));
  }
}

export function SessionActions({ session, resumeCommand }: { session: SessionInfo; resumeCommand: string }) {
  return (
    <ActionPanel>
      <Action title="Open in Terminal" icon={Icon.Terminal} onAction={() => openInTerminal(session, resumeCommand)} />
      <Action
        title="Copy Session ID"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        onAction={() => {
          Clipboard.copy(session.sessionId);
          showToast({ style: Toast.Style.Success, title: "Session ID copied" });
        }}
      />
      <Action
        title="Open in Finder"
        icon={Icon.Finder}
        shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
        onAction={() => showInFinder(session.projectPath)}
      />
      <Action
        title="Open in IDE"
        icon={Icon.Code}
        shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
        onAction={() => openInIDE(session)}
      />
    </ActionPanel>
  );
}
