import { readCredentials, saveCredentials } from "./core/auth.js";
import { createAPI } from "./core/api.js";
import { createConnection } from "./core/connection.js";
import { createRouter } from "./core/router.js";
import { icon, element } from "./core/dom.js";
import { createChatPage } from "./pages/chat.js";
import { createLogsPage } from "./pages/logs.js";
import { createSettingsPage } from "./pages/settings.js";

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
let warned = false;
let remembered = null;
let account = "";

function addNotice(level, text) {
  const scroll = ui["notice-scroll"];
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const notice = element("article", `notice ${level}`);
  const meta = element("div", "notice-meta");
  const time = element("time", "", timeFormat.format(new Date()));
  time.dateTime = new Date().toISOString();
  meta.append(element("span", "notice-level", level), time);
  if (text.length > 400) {
    const details = element("details");
    details.append(element("summary", "", text.split("\n")[0].slice(0, 90)), element("div", "notice-text", text));
    notice.append(meta, details);
  } else notice.append(meta, element("div", "notice-text", text));
  ui.notices.append(notice);
  while (ui.notices.childElementCount > 200) ui.notices.firstElementChild.remove();
  ui["notice-count"].textContent = ui.notices.childElementCount;
  ui["notice-empty"].hidden = true;
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  if (document.body.classList.contains("notices-hidden")) ui["notice-unread"].hidden = false;
}

function clearNotices() {
  ui.notices.replaceChildren();
  ui["notice-count"].textContent = "0";
  ui["notice-empty"].hidden = false;
  ui["notice-unread"].hidden = true;
}

function storageWarning() {
  if (warned) return;
  warned = true;
  addNotice("WARN", "登录信息保存失败，下次需重新登录");
}

function showLogin(message = "") {
  ui["login-error"].hidden = !message;
  ui["login-error"].textContent = message;
  if (!ui["login-dialog"].open) ui["login-dialog"].showModal();
}

function toggleNotices(show) {
  if (show && matchMedia("(max-width: 760px)").matches) chat.closeSessions();
  document.body.classList.toggle("notices-hidden", !show);
  ui["notice-toggle"].setAttribute("aria-expanded", String(show));
  ui["notice-panel"].inert = !show;
  ui["notice-backdrop"].hidden = !show || !matchMedia("(max-width: 1000px)").matches;
  if (show) ui["notice-unread"].hidden = true;
}

const connection = createConnection({
  onMessage(message) {
    if (message.type === "notice") addNotice(message.level || "INFO", message.text || "");
    else chat.handleMessage(message);
  },
  onStateChange(snapshot) {
    if (snapshot.credentials && snapshot.credentials.clientID !== account) {
      account = snapshot.credentials.clientID;
      logs.reset();
      settings.reset();
      clearNotices();
    }
    ui["connection-label"].textContent = snapshot.label;
    ui["connection-dot"].className = `status-dot ${snapshot.ready ? "online" : snapshot.credentials ? "busy" : ""}`;
    ui["login-submit"].disabled = !!snapshot.credentials && !snapshot.ready;
    ui["disconnect-button"].hidden = !snapshot.credentials && !remembered;
    chat.setConnection(snapshot);
  },
  onAuthenticated(credentials) {
    remembered = credentials;
    saveCredentials(credentials, storageWarning);
    ui["client-id"].value = credentials.clientID;
    ui["login-token"].value = "";
    ui["login-error"].hidden = true;
    ui["disconnect-button"].hidden = false;
    ui["login-submit"].disabled = false;
    if (ui["login-dialog"].open) ui["login-dialog"].close();
    logs.reload();
    settings.reload();
  },
  onAuthenticationError(message) { showLogin(message); },
});
const api = createAPI({
  getCredentials: () => connection.state.credentials,
  getConnectionToken: () => connection.state.apiToken,
  onUnauthorized() {
    connection.disconnect();
    showLogin("认证失效，请检查 ID / Token");
  },
});
const chat = createChatPage({ ui, api, connection, addNotice, showLogin, closeNotices: () => toggleNotices(false) });
const logs = createLogsPage({ ui, api });
const settings = createSettingsPage({ ui, api });
createRouter({
  pages: { chat, logs, settings },
  onChange(name) {
    ui["session-toggle"].hidden = name !== "chat";
    document.title = `${{ chat: "聊天", logs: "日志", settings: "设置" }[name]} · ElBot`;
  },
});

function applyTheme(preference = document.documentElement.dataset.themePreference || "") {
  const root = document.documentElement;
  const dark = preference ? preference === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePreference = preference;
  const label = dark ? "切换到浅色主题" : "切换到深色主题";
  ui["theme-toggle"].replaceChildren(icon(dark ? "sun" : "moon"));
  ui["theme-toggle"].setAttribute("aria-label", label);
  ui["theme-toggle"].setAttribute("aria-pressed", String(dark));
  ui["theme-toggle"].title = label;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#2d3c4f" : "#f5f7fa";
}

ui["theme-toggle"].addEventListener("click", () => {
  const preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(preference);
  try { localStorage.setItem("elbot.theme", preference); } catch {}
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.dataset.themePreference) applyTheme();
});
ui["login-form"].addEventListener("submit", event => {
  event.preventDefault();
  const credentials = { clientID: ui["client-id"].value.trim(), token: ui["login-token"].value };
  ui["login-error"].hidden = true;
  connection.connect(credentials);
});
ui["connection-button"].addEventListener("click", () => showLogin());
ui["login-close"].addEventListener("click", () => ui["login-dialog"].close());
ui["disconnect-button"].addEventListener("click", () => {
  remembered = null;
  account = "";
  saveCredentials(null, storageWarning);
  connection.disconnect();
  chat.reset();
  logs.reset();
  settings.reset();
  clearNotices();
  ui["login-token"].value = "";
  showLogin();
});
ui["notice-toggle"].addEventListener("click", () => toggleNotices(document.body.classList.contains("notices-hidden")));
ui["notice-backdrop"].addEventListener("click", () => toggleNotices(false));
ui["clear-notices"].addEventListener("click", clearNotices);
matchMedia("(max-width: 1000px)").addEventListener("change", () => toggleNotices(!document.body.classList.contains("notices-hidden")));
document.addEventListener("keydown", event => { if (event.key === "Escape") toggleNotices(false); });
window.addEventListener("pagehide", () => connection.disconnect());
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    const credentials = readCredentials(storageWarning);
    if (credentials) connection.connect(credentials);
  }
});
applyTheme();
toggleNotices(false);
remembered = readCredentials(storageWarning);
if (remembered) {
  ui["client-id"].value = remembered.clientID;
  connection.connect(remembered);
} else showLogin();
