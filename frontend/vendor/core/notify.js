import { element } from "./dom.js";

export function createNotify() {
  let container = null;

  function getContainer() {
    if (container?.isConnected) return container;
    container = element("div", "toast-stack");
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-relevant", "additions");
    document.body.append(container);
    return container;
  }

  return function notify(level, text) {
    if (!text) return;
    const severity = ["SUCCESS", "WARN", "ERROR"].includes(level) ? level : "INFO";
    const toast = element("div", `toast ${severity}`, text);
    toast.setAttribute("role", severity === "ERROR" ? "alert" : "status");
    getContainer().append(toast);

    const duration = severity === "ERROR" ? 7000 : 4500;
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) toast.remove();
        else toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-out", fill: "forwards" }).onfinish = () => toast.remove();
      }, duration);
    };
    toast.addEventListener("pointerenter", () => clearTimeout(timer));
    toast.addEventListener("pointerleave", dismiss);
    dismiss();
    while (container.childElementCount > 4) container.firstElementChild.remove();
  };
}
