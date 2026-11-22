import { element, iconButton } from "../core/dom.js";

// 消息正文、确认详情、Markdown 代码块与侧栏 Git 面板共用同一套 diff 渲染。
// 聊天内结构：.diff-block > .diff-head（文件名 + 增删统计 + 展开/悬浮窗）+ pre.diff-view（默认折叠）
// 字体走 --mono-diff（CodeNewRoman Nerd Font Mono），字号 .875rem，与工具结果正文一致。
export function renderDiff(target, diff, fileSummary) {
  const text = String(diff).replace(/\r/g, "");
  const pre = diffPre(text);
  const { added, removed } = countChanges(text);
  const stats = element("span", "diff-stats");
  if (added) stats.append(element("span", "diff-stat-added", `+${added}`));
  if (removed) stats.append(element("span", "diff-stat-removed", `-${removed}`));
  const expand = iconButton("expand", "悬浮查看 diff", () => openDiffDialog(text));
  expand.classList.add("diff-expand");
  if (fileSummary) {
    fileSummary.append(stats, expand);
    const details = fileSummary.closest("details");
    const collapse = iconButton("chevron", "收起 diff", () => {
      details.open = false;
      fileSummary.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    collapse.classList.add("diff-collapse");
    target.replaceChildren(pre, collapse);
    return;
  }

  pre.hidden = true;
  const head = element("div", "diff-head");
  const label = element("span", "diff-label", diffTitle(text));
  label.title = label.textContent;
  const toggle = iconButton("chevron", "展开 diff", () => {
    pre.hidden = !pre.hidden;
    const next = pre.hidden ? "展开 diff" : "收起 diff";
    toggle.title = next;
    toggle.setAttribute("aria-label", next);
    toggle.setAttribute("aria-expanded", String(!pre.hidden));
    toggle.classList.toggle("expanded", !pre.hidden);
  });
  toggle.classList.add("diff-toggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.prepend(label, stats);
  head.append(toggle, expand);
  const block = element("div", "diff-block");
  block.append(head, pre);
  target.replaceChildren(block);
}

function diffPre(text) {
  const pre = element("pre", "diff-view");
  const code = element("code", "diff-lines");
  for (const line of text.split("\n")) {
    const row = element("span");
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ") || line.startsWith("--- ") || line.startsWith("+++ ")) row.className = "diff-file-header";
    else if (line.startsWith("@@")) row.className = "diff-hunk";
    else if (line.startsWith("\\ No newline")) row.className = "diff-meta";
    else if (line.startsWith("+")) row.className = "diff-added";
    else if (line.startsWith("-")) row.className = "diff-removed";
    else row.className = "diff-context";
    row.textContent = line;
    code.append(row, document.createTextNode("\n"));
  }
  pre.append(code);
  return pre;
}

function countChanges(text) {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function diffTitle(text) {
  const git = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
  if (git) return git[1] === git[2] ? git[1] : `${git[1]} → ${git[2]}`;
  const unified = /^\+\+\+ b\/(.+)$/m.exec(text);
  return unified ? unified[1] : "Diff";
}

// 悬浮窗单例：跨消息复用，Esc、遮罩与关闭按钮均可关闭。
let view = null;

function ensureDialog() {
  if (view?.dialog.isConnected) return view;
  const dialog = element("dialog", "diff-dialog");
  dialog.setAttribute("aria-labelledby", "diff-dialog-title");
  const head = element("div", "diff-dialog-head");
  const title = element("h2", "diff-dialog-title");
  title.id = "diff-dialog-title";
  const close = iconButton("close", "关闭", () => dialog.close());
  close.classList.add("diff-dialog-close");
  head.append(title, close);
  const body = element("div", "diff-dialog-body");
  dialog.append(head, body);
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  view = { dialog, title, body };
  return view;
}

function openDiffDialog(text) {
  const target = ensureDialog();
  target.title.textContent = diffTitle(text);
  target.body.replaceChildren(diffPre(text));
  target.dialog.showModal();
}
