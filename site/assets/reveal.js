// Fades the Agent Shinx page in from below as it scrolls into view: the
// intro, each section, and the pieces inside them, one after another.
// Skipped when the reader prefers reduced motion or the browser has no
// IntersectionObserver -- the page then just shows as it is.
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;

  const targets = document.querySelectorAll(
    ".intro > *, main section > h2, main section > .section-note, .command-groups > div, .feeds li, .permissions li, main section > .actions, .gallery figure"
  );

  const observer = new IntersectionObserver((entries) => {
    let delay = 0;
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      // Items arriving together come in a beat apart rather than all at once.
      setTimeout(() => entry.target.classList.add("is-visible"), delay);
      delay += 80;
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px" });

  targets.forEach((el) => {
    el.classList.add("reveal");
    observer.observe(el);
  });
  document.documentElement.classList.add("reveal-ready");
})();
