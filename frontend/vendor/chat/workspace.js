import { element, icon } from "../core/dom.js";
import { renderDiff } from "./diff.js";

export function createWorkspace({ ui, state: chat, api }) {
  const panel = { side: "agent", directory: null, info: null, infoVersion: 0, gitVersion: 0, directoryVersion: 0, syncing: false };

  function updateControls() {
    const disabled = !chat.ready || !chat.sessionID || chat.navigating || chat.recoveryBlocked || panel.syncing;
    ui["workspace-browse"].disabled = disabled;
    ui["agent-to-user"].disabled = disabled;
    ui["user-to-agent"].disabled = disabled;
    ui["workspace-refresh"].disabled = disabled;
    ui["git-agent-side"].disabled = disabled;
    ui["git-user-side"].disabled = disabled;
  }

  function renderWorkspaceSettings() {
    const data = panel.info;
    const agentPath = data?.agent_path || "未设置";
    const userPath = data?.user_path || "未设置";
    ui["agent-path"].textContent = agentPath;
    ui["agent-path"].title = agentPath;
    ui["user-path"].textContent = userPath;
    ui["user-path"].title = userPath;
    ui["agent-to-user"].checked = !!data?.agent_to_user;
    ui["user-to-agent"].checked = !!data?.user_to_agent;
    updateControls();
  }

  function renderGitStatus(data) {
    const changes = data.changes || [];
    const count = changes.length;
    ui["git-change-count"].textContent = count;
    ui["workspace-change-indicator"].textContent = count ? count : "";
    ui["workspace-change-indicator"].hidden = !count;
    ui["git-path"].textContent = data.path || "";
    ui["git-path"].title = data.root || data.path || "";
    ui["git-changes"].replaceChildren();
    if (!data.is_git) {
      ui["git-feedback"].textContent = "非 Git 仓库或 Git 配置无效";
      return;
    }
    ui["git-feedback"].textContent = count ? count + " 个文件有改动" : "工作区干净";
    if (!count) return;
    const groups = [
      ["已暂存的更改", changes.filter(change => change.staged)],
      ["更改", changes.filter(change => change.worktree || change.status === "untracked")],
    ];
    for (const [label, files] of groups) {
      if (!files.length) continue;
      const group = element("section", "git-change-group");
      group.append(element("h3", "git-change-heading", label));
      for (const change of files) group.append(createGitFile(change));
      ui["git-changes"].append(group);
    }
  }

  function createGitFile(change) {
    const details = element("details", "git-file");
    const summary = element("summary", "git-file-summary");
    const statusLabel = ({ modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" })[change.status] || "?";
    const status = element("span", "git-file-status " + change.status, statusLabel);
    const path = element("span", "git-file-path", change.path);
    summary.append(status, path);
    const content = element("div", "git-file-diff");
    details.append(summary, content);
    let loaded = false;
    let loading = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded || loading) return;
      loading = true;
      content.textContent = "读取 diff…";
      const version = panel.gitVersion;
      const sessionID = chat.sessionID;
      const side = panel.side;
      try {
        const query = new URLSearchParams({ side, path: change.path });
        const data = await api("/workspace/git/diff?" + query);
        if (version !== panel.gitVersion || sessionID !== chat.sessionID || side !== panel.side) return;
        renderDiff(content, data.diff || "", summary);
        loaded = true;
      } catch (error) {
        if (version === panel.gitVersion && sessionID === chat.sessionID) content.textContent = error.message;
      } finally {
        loading = false;
      }
    });
    return details;
  }

  async function refreshGit() {
    if (!chat.ready || !chat.sessionID) return;
    const version = ++panel.gitVersion;
    const sessionID = chat.sessionID;
    const side = panel.side;
    ui["git-feedback"].textContent = "读取 Git 状态…";
    try {
      const data = await api("/workspace/git?" + new URLSearchParams({ side }));
      if (version !== panel.gitVersion || sessionID !== chat.sessionID || side !== panel.side) return;
      renderGitStatus(data);
    } catch (error) {
      if (version === panel.gitVersion && sessionID === chat.sessionID) {
        ui["git-feedback"].textContent = error.message;
        ui["git-changes"].replaceChildren();
        ui["git-change-count"].textContent = "!";
        ui["workspace-change-indicator"].textContent = "!";
        ui["workspace-change-indicator"].hidden = false;
      }
    }
  }

  async function refresh(newView = false) {
    const unavailable = !chat.ready || !chat.sessionID;
    if (newView || unavailable) {
      panel.gitVersion++;
      panel.directoryVersion++;
      panel.syncing = false;
      panel.directory = null;
      panel.info = null;
      ui["directory-path"].textContent = ui["directory-path"].title = "";
      ui["directory-list"].replaceChildren();
      ui["directory-up"].disabled = true;
      ui["set-user-workspace"].disabled = true;
      ui["directory-feedback"].textContent = unavailable ? "连接后查看工作区" : "";
      ui["workspace-settings-feedback"].textContent = "";
      renderWorkspaceSettings();
      ui["git-path"].textContent = ui["git-path"].title = "";
      ui["git-changes"].replaceChildren();
      ui["git-change-count"].textContent = "0";
      ui["workspace-change-indicator"].hidden = true;
    }
    const version = ++panel.infoVersion;
    if (unavailable) {
      ui["git-feedback"].textContent = "连接后查看工作区";
      return;
    }
    const sessionID = chat.sessionID;
    ui["git-feedback"].textContent = "读取工作区…";
    try {
      const data = await api("/workspace");
      if (version !== panel.infoVersion || sessionID !== chat.sessionID) return;
      panel.info = data;
      renderWorkspaceSettings();
      await refreshGit();
    } catch (error) {
      if (version === panel.infoVersion && sessionID === chat.sessionID) {
        ui["git-feedback"].textContent = error.message;
        renderWorkspaceSettings();
      }
    }
  }

  function setWorkspaceContentTab(tab) {
    const changes = tab === "changes";
    ui["workspace-changes-tab"].classList.toggle("selected", changes);
    ui["workspace-changes-tab"].setAttribute("aria-selected", String(changes));
    ui["workspace-directory-tab"].classList.toggle("selected", !changes);
    ui["workspace-directory-tab"].setAttribute("aria-selected", String(!changes));
    ui["git-view"].hidden = !changes;
    ui["directory-view"].hidden = changes;
  }

  async function browseDirectories(path = "") {
    if (!chat.ready || !chat.sessionID) return;
    const version = ++panel.directoryVersion;
    const sessionID = chat.sessionID;
    ui["directory-feedback"].textContent = "读取目录…";
    ui["directory-list"].replaceChildren();
    ui["set-user-workspace"].disabled = true;
    try {
      const query = path ? "?" + new URLSearchParams({ path }) : "";
      const data = await api("/workspace/directories" + query);
      if (version !== panel.directoryVersion || sessionID !== chat.sessionID) return;
      panel.directory = data;
      ui["directory-path"].textContent = data.path;
      ui["directory-path"].title = data.path;
      ui["directory-up"].disabled = !data.parent;
      ui["set-user-workspace"].disabled = !data.path;
      ui["directory-feedback"].textContent = data.directories.length ? "" : "没有子目录";
      for (const directory of data.directories) {
        const button = element("button", "directory-entry");
        button.type = "button";
        button.title = directory.path;
        button.append(icon("folder"), element("span", "", directory.name));
        button.addEventListener("click", () => browseDirectories(directory.path));
        ui["directory-list"].append(button);
      }
    } catch (error) {
      if (version === panel.directoryVersion && sessionID === chat.sessionID) {
        ui["directory-feedback"].textContent = error.message;
      }
    }
  }

  async function chooseUserWorkspace() {
    const path = panel.directory?.path;
    if (!path) return;
    const view = chat.viewVersion;
    panel.infoVersion++;
    panel.gitVersion++;
    ui["set-user-workspace"].disabled = true;
    ui["directory-feedback"].textContent = "更新用户工作区…";
    try {
      const info = await api("/workspace/user", { method: "PUT", body: { path } });
      if (view !== chat.viewVersion) return;
      panel.info = info;
      renderWorkspaceSettings();
      ui["directory-feedback"].textContent = "用户工作区已更新";
      await refreshGit();
    } catch (error) {
      if (view === chat.viewVersion) ui["directory-feedback"].textContent = error.message;
    } finally {
      if (view === chat.viewVersion) ui["set-user-workspace"].disabled = !panel.directory?.path;
    }
  }

  async function updateWorkspaceSync() {
    const agentToUser = ui["agent-to-user"].checked;
    const userToAgent = ui["user-to-agent"].checked;
    const view = chat.viewVersion;
    panel.syncing = true;
    updateControls();
    panel.infoVersion++;
    panel.gitVersion++;
    ui["workspace-settings-feedback"].textContent = "更新路径同步…";
    try {
      const info = await api("/workspace/sync", {
        method: "PUT", body: { agent_to_user: agentToUser, user_to_agent: userToAgent },
      });
      if (view !== chat.viewVersion) return;
      panel.info = info;
      renderWorkspaceSettings();
      ui["workspace-settings-feedback"].textContent = "路径同步设置已更新";
      await refreshGit();
    } catch (error) {
      if (view !== chat.viewVersion) return;
      renderWorkspaceSettings();
      ui["workspace-settings-feedback"].textContent = error.message;
    } finally {
      if (view === chat.viewVersion) { panel.syncing = false; updateControls(); }
    }
  }

  ui["workspace-changes-tab"].addEventListener("click", () => setWorkspaceContentTab("changes"));
  ui["workspace-directory-tab"].addEventListener("click", () => setWorkspaceContentTab("directory"));
  ui["workspace-browse"].addEventListener("click", async () => {
    setWorkspaceContentTab("directory");
    await browseDirectories(panel.info?.user_path || "");
  });
  ui["directory-up"].addEventListener("click", () => {
    if (panel.directory?.parent) browseDirectories(panel.directory.parent);
  });
  ui["set-user-workspace"].addEventListener("click", chooseUserWorkspace);
  ui["agent-to-user"].addEventListener("change", updateWorkspaceSync);
  ui["user-to-agent"].addEventListener("change", updateWorkspaceSync);
  ui["workspace-refresh"].addEventListener("click", refreshGit);
  ui["git-agent-side"].addEventListener("click", () => {
    panel.side = "agent";
    ui["git-agent-side"].classList.add("selected");
    ui["git-agent-side"].setAttribute("aria-pressed", "true");
    ui["git-user-side"].classList.remove("selected");
    ui["git-user-side"].setAttribute("aria-pressed", "false");
    refreshGit();
  });
  ui["git-user-side"].addEventListener("click", () => {
    panel.side = "user";
    ui["git-user-side"].classList.add("selected");
    ui["git-user-side"].setAttribute("aria-pressed", "true");
    ui["git-agent-side"].classList.remove("selected");
    ui["git-agent-side"].setAttribute("aria-pressed", "false");
    refreshGit();
  });

  return { refresh, updateControls, sessionChanged: () => refresh(true) };
}
