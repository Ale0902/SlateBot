// Screenshot gallery on the Agent Shinx page. Each picture fades in once
// it has downloaded; one that can't be loaded is swapped for a short note
// instead of leaving a broken-image icon. With scripts off, the pictures
// just appear as they arrive.
document.querySelectorAll(".gallery img").forEach((img) => {
  const failed = () => {
    const note = document.createElement("div");
    note.className = "failed";
    note.textContent = "This screenshot couldn't be loaded.";
    (img.closest("a") || img).replaceWith(note);
  };

  if (img.complete) {
    if (!img.naturalWidth) failed();
    return;
  }
  img.classList.add("is-loading");
  img.addEventListener("load", () => img.classList.remove("is-loading"), { once: true });
  img.addEventListener("error", failed, { once: true });
});
