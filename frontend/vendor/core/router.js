export function createRouter({ pages, onChange }) {
  let current = "";
  function navigate() {
    const name = location.hash.replace(/^#\/?/, "") || "chat";
    const next = Object.hasOwn(pages, name) ? name : "chat";
    if (name !== next || !location.hash) history.replaceState(null, "", `#/${next}`);
    if (current === next) return;
    if (current) pages[current].hide();
    current = next;
    pages[current].show();
    for (const button of document.querySelectorAll("[data-page]")) {
      const active = button.dataset.page === current;
      button.classList.toggle("current", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    onChange(current);
  }
  for (const button of document.querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => { location.hash = `/${button.dataset.page}`; });
  }
  window.addEventListener("hashchange", navigate);
  navigate();
  return { current: () => current };
}
