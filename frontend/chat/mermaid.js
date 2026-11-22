// Mermaid 代码块交给 pele 渲染；它自己转义图文，不能再过 DOMPurify，否则会剥掉 foreignObject。
import { element, iconButton } from "../core/dom.js";

const MOUNT_OPTIONS = {
  links: false,  // 聊天场景不保留外链
  images: false, // 阻止图内图片发起网络请求
  zoom: false,   // 尺寸由容器控制，不需要缩放控件
};

export function createMermaid({ clipboard }) {
  // pele 内部已按容器记录实例，这里只额外保存句柄，用于在 innerHTML 丢弃节点前提前释放观察器。
  const diagrams = new WeakMap();

  // 唯一的 mount 入口：统一选项与错误处理，失败返回 null。
  function mount(container, source) {
    if (!window.pele) return null;
    const diagram = window.pele.mount(container, source, MOUNT_OPTIONS);
    if (diagram.error) {
      diagram.destroy();
      container.replaceChildren();
      return null;
    }
    diagrams.set(container, diagram);
    return diagram;
  }

  // 只清 root 内即将被 innerHTML 丢弃的图，不影响其他消息或状态卡。
  function clear(root) {
    for (const node of root.querySelectorAll(".mermaid-body")) {
      diagrams.get(node)?.destroy();
      diagrams.delete(node);
    }
  }

  // 渲染成带工具栏的块；失败返回 null，由调用方保留原代码块。
  function render(source, block) {
    const toolbar = element("div", "mermaid-head");
    toolbar.append(element("span", "mermaid-label", "Mermaid"));
    const body = element("div", "mermaid-body");
    block.append(toolbar, body);
    if (!mount(body, source)) {
      block.remove();
      return null;
    }
    const copyButton = iconButton("copy", "复制图表源码", () => clipboard.copy(source, copyButton, "图表源码已复制"));
    toolbar.append(
      copyButton,
      iconButton("expand", "悬浮查看图表", () => openDialog(source)),
    );
    return block;
  }

  return { render, clear };
}

// 悬浮窗单例：跨消息复用，Esc、遮罩与关闭按钮均可关闭。
let view = null;

function ensureDialog() {
  if (view?.dialog.isConnected) return view;
  const dialog = element("dialog", "mermaid-dialog");
  dialog.setAttribute("aria-labelledby", "mermaid-dialog-title");
  const head = element("div", "mermaid-dialog-head");
  const title = element("h2", "mermaid-dialog-title", "Mermaid");
  title.id = "mermaid-dialog-title";
  const close = iconButton("close", "关闭", () => dialog.close());
  close.classList.add("mermaid-dialog-close");
  head.append(title, close);
  const body = element("div", "mermaid-dialog-body");
  dialog.append(head, body);
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  view = { dialog, body, diagram: null };
  return view;
}

function openDialog(source) {
  if (!window.pele) return;
  const target = ensureDialog();
  target.diagram?.destroy();
  target.body.replaceChildren();
  const holder = element("div", "mermaid");
  target.body.append(holder);
  target.diagram = window.pele.mount(holder, source, MOUNT_OPTIONS);
  // 语法错误时 pele 会把错误画进容器，不弹空窗口。
  if (target.diagram.error) {
    target.diagram.destroy();
    target.diagram = null;
    target.body.replaceChildren();
    return;
  }
  target.dialog.showModal();
}

