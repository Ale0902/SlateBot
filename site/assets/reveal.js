// Fades everything on the Agent Shinx page in from below as it scrolls into
// view: the header, the intro and its picture, each section and the pieces
// inside them, and the footer, one after another.
//
// Loaded in <head> without defer, so the page is marked before anything is
// drawn and nothing flashes up before fading in. Skipped when the reader
// prefers reduced motion or the browser has no IntersectionObserver -- the
// page then just shows as it is. If this script dies partway, a CSS
// failsafe shows the page anyway after a few seconds.
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const root = document.documentElement;
  root.classList.add("reveal-ready");

  const TARGETS = [
    ".site-header",
    ".intro .eyebrow", ".intro h1", ".intro .lede", ".intro-avatar", ".hero-actions",
    "main section > :not(.command-groups, .feeds, .permissions, .gallery)",
    ".command-groups > div", ".feeds li", ".permissions li", ".gallery figure",
    ".site-footer",
  ].join(", ");

  document.addEventListener("DOMContentLoaded", () => {
    const observer = new IntersectionObserver((entries) => {
      let delay = 0;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        // Items arriving together come in a beat apart rather than all at
        // once -- the first starts right away, and the whole run is capped
        // so the first screenful is fully in within a fraction of a second.
        const show = () => entry.target.classList.add("is-visible");
        delay ? setTimeout(show, delay) : show();
        delay = Math.min(delay + 40, 240);
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -6% 0px" });

    document.querySelectorAll(TARGETS).forEach((el) => {
      el.classList.add("reveal");
      observer.observe(el);
    });
    root.classList.add("reveal-set");
  });
})();
