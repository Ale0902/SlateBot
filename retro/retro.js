// Extras for the retro skin, on top of ../dist/main.js: text size, your
// buddy icon, and the color of your text and its background. All of it is
// saved in this browser only.
(() => {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const input = $("input");

  function load(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // null removes the key, so going back to a default doesn't leave it pinned.
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch {
      return false; // storage full or blocked -- the choice just won't persist
    }
  }

  // ---- Text size ----
  const SIZE_KEY = "celta-chat.retroTextSize";
  let size = Number(load(SIZE_KEY, "16")) || 16;

  function setSize(next) {
    size = Math.min(22, Math.max(12, next));
    root.style.setProperty("--chat-size", `${size}px`);
    save(SIZE_KEY, String(size));
  }

  setSize(size);
  $("textSmaller").addEventListener("click", () => setSize(size - 2));
  $("textLarger").addEventListener("click", () => setSize(size + 2));

  // ---- Popovers: one open at a time; a click elsewhere or Escape closes it ----
  let open = null;

  function closePopover(returnFocus) {
    if (!open) return;
    open.panel.hidden = true;
    open.button.setAttribute("aria-expanded", "false");
    if (returnFocus) open.button.focus();
    open = null;
  }

  function togglePopover(button, panel) {
    const wasOpen = open?.panel === panel;
    closePopover(false);
    if (wasOpen) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    open = { button, panel };
    (panel.querySelector('[aria-pressed="true"]') ?? panel.querySelector("button, input"))?.focus();
  }

  document.addEventListener("pointerdown", (e) => {
    if (open && !open.panel.contains(e.target) && !open.button.contains(e.target)) closePopover(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      closePopover(true);
    }
  });

  function popoverTitle(text) {
    const title = document.createElement("div");
    title.className = "popover-title";
    title.textContent = text;
    return title;
  }

  // ---- Buddy icons: 16x16 pixel art, one path per color ----
  const ICONS = [
    {
      id: "shades",
      label: "Smiley with sunglasses",
      bg: "#6b2fa0",
      paths: [
        ["#ffd23f", "M5 2h6v1H5zM4 3h8v1H4zM3 4h10v7H3zM4 11h8v1H4zM5 12h6v1H5z"],
        ["#1a1a1a", "M4 5h3v2H4zm5 0h3v2H9zM7 5h2v1H7zM5 9h1v1H5zm5 0h1v1h-1zM6 10h4v1H6z"],
      ],
    },
    {
      id: "cat",
      label: "Cat",
      bg: "#8fd0ff",
      paths: [
        ["#f5a142", "M3 2h2v1H3zm8 0h2v1h-2zM3 3h3v1H3zm7 0h3v1h-3zM3 4h10v8H3zM4 12h8v1H4z"],
        ["#1a1a1a", "M5 6h2v2H5zm4 0h2v2H9zM6 10h1v1H6zm3 0h1v1H9zM1 9h2v1H1zm12 0h2v1h-2z"],
        ["#f27a9b", "M7 9h2v1H7z"],
      ],
    },
    {
      id: "alien",
      label: "Alien",
      bg: "#0d0d2b",
      paths: [
        ["#7ee36b", "M5 2h6v1H5zM4 3h8v1H4zM3 4h10v4H3zM4 8h8v2H4zm1 2h6v2H5zm1 2h4v1H6z"],
        ["#0d0d2b", "M4 5h3v2H4zm5 0h3v2H9zM7 10h2v1H7z"],
      ],
    },
    {
      id: "ghost",
      label: "Ghost",
      bg: "#2b3a67",
      paths: [
        ["#f4f4f4", "M5 3h6v1H5zM4 4h8v1H4zM3 5h10v7H3zm0 7h2v1H3zm4 0h2v1H7zm4 0h2v1h-2z"],
        ["#2b3a67", "M5 6h2v3H5zm4 0h2v3H9z"],
      ],
    },
    {
      id: "soccer",
      label: "Soccer ball",
      bg: "#2f8f3f",
      paths: [
        ["#ffffff", "M5 2h6v1H5zM4 3h8v1H4zM3 4h10v7H3zM4 11h8v1H4zM5 12h6v1H5z"],
        ["#1a1a1a", "M7 2h2v1H7zM7 6h2v1H7zM6 7h4v2H6zM3 7h1v2H3zm9 0h1v2h-1zM5 11h2v1H5zm4 0h2v1H9z"],
      ],
    },
    {
      id: "note",
      label: "Music note",
      bg: "#ffcf3f",
      paths: [["#1a1a1a", "M9 2h1v9H9zm1 1h2v1h-2zm1 1h2v1h-2zm1 1h1v2h-1zM5 10h5v3H5z"]],
    },
    {
      id: "heart",
      label: "Heart",
      bg: "#1a1a1a",
      paths: [
        ["#e8323c", "M3 4h4v1H3zm6 0h4v1H9zM2 5h12v3H2zm1 3h10v1H3zm1 1h8v1H4zm1 1h6v1H5zm1 1h4v1H6zm1 1h2v1H7z"],
        ["#ffffff", "M4 5h1v1H4z"],
      ],
    },
    {
      id: "star",
      label: "Star",
      bg: "#1f3fd0",
      paths: [
        ["#ffd23f", "M7 1h2v3H7zM6 4h4v1H6zM1 5h14v2H1zm2 2h10v1H3zm1 1h8v2H4zm0 2h3v1H4zm5 0h3v1H9zm-6 1h3v1H3zm7 0h3v1h-3zm-7 1h2v1H3zm8 0h2v1h-2z"],
      ],
    },
  ];

  const ICON_KEY = "celta-chat.retroIcon";
  const CUSTOM_ICON_KEY = "celta-chat.retroCustomIcon";
  // Uploads are center-cropped to a square this size, about 10KB saved.
  const CUSTOM_ICON_SIZE = 64;

  const iconBtn = $("myIconBtn");
  const iconPicker = $("iconPicker");
  const iconGrid = $("iconGrid");
  const iconFile = $("iconFile");
  const iconNote = $("iconNote");
  let iconChoice = load(ICON_KEY, "shades");
  let customIcon = load(CUSTOM_ICON_KEY, null);

  function iconArt(id) {
    if (id === "custom" && customIcon) {
      const img = document.createElement("img");
      img.src = customIcon;
      img.alt = "";
      return img;
    }
    const icon = ICONS.find((i) => i.id === id) ?? ICONS[0];
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("aria-hidden", "true");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", "16");
    bg.setAttribute("height", "16");
    bg.setAttribute("fill", icon.bg);
    svg.appendChild(bg);
    for (const [fill, d] of icon.paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", fill);
      svg.appendChild(path);
    }
    return svg;
  }

  function renderIcons() {
    if (iconChoice === "custom" ? !customIcon : !ICONS.some((i) => i.id === iconChoice)) iconChoice = "shades";
    iconBtn.replaceChildren(iconArt(iconChoice));

    const choices = ICONS.map((i) => ({ id: i.id, label: i.label }));
    if (customIcon) choices.push({ id: "custom", label: "Your uploaded icon" });
    iconGrid.replaceChildren(
      ...choices.map(({ id, label }) => {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "icon-choice";
        choice.title = label;
        choice.setAttribute("aria-label", label);
        choice.setAttribute("aria-pressed", String(id === iconChoice));
        choice.appendChild(iconArt(id));
        choice.addEventListener("click", () => {
          pickIcon(id);
          closePopover(false);
          input.focus();
        });
        return choice;
      })
    );
  }

  function pickIcon(id) {
    iconChoice = id;
    save(ICON_KEY, id === "shades" ? null : id);
    renderIcons();
  }

  async function readIcon(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = CUSTOM_ICON_SIZE;
      canvas
        .getContext("2d")
        .drawImage(
          img,
          (img.naturalWidth - side) / 2,
          (img.naturalHeight - side) / 2,
          side,
          side,
          0,
          0,
          CUSTOM_ICON_SIZE,
          CUSTOM_ICON_SIZE
        );
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function showIconNote(text) {
    iconNote.textContent = text;
    iconNote.hidden = !text;
  }

  iconBtn.addEventListener("click", () => {
    showIconNote("");
    togglePopover(iconBtn, iconPicker);
  });

  $("iconUploadBtn").addEventListener("click", () => iconFile.click());

  iconFile.addEventListener("change", async () => {
    const file = iconFile.files?.[0];
    iconFile.value = ""; // so picking the same file again still fires "change"
    if (!file) return;
    try {
      const dataUrl = await readIcon(file);
      customIcon = dataUrl;
      pickIcon("custom");
      showIconNote(save(CUSTOM_ICON_KEY, dataUrl) ? "" : "Set for now, but it couldn't be saved for next time.");
    } catch {
      showIconNote("Couldn't open that image -- try a JPEG, PNG, WebP or GIF.");
    }
  });

  renderIcons();

  // ---- Your text color and background ----
  // Applied to the message box and to every one of your lines in the chat.
  const PALETTE = [
    ["#000000", "Black"], ["#808080", "Gray"], ["#c0c0c0", "Silver"], ["#ffffff", "White"],
    ["#800000", "Maroon"], ["#ff0000", "Red"], ["#ff8000", "Orange"], ["#ffff00", "Yellow"],
    ["#008000", "Green"], ["#00c000", "Lime"], ["#008080", "Teal"], ["#00ffff", "Aqua"],
    ["#000080", "Navy"], ["#0000ff", "Blue"], ["#800080", "Purple"], ["#ff00ff", "Magenta"],
  ];
  const HEX_RE = /^#[0-9a-f]{6}$/i;

  const colors = {
    text: {
      key: "celta-chat.retroTextColor",
      fallback: "#161616",
      cssVar: "--user-text",
      title: "Text Color",
      button: $("textColorBtn"),
      panel: $("textColorPicker"),
    },
    bg: {
      key: "celta-chat.retroTextBg",
      fallback: "#ffffff",
      cssVar: "--user-bg",
      title: "Background Color",
      button: $("bgColorBtn"),
      panel: $("bgColorPicker"),
    },
  };

  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  function setColor(kind, hex) {
    const color = colors[kind];
    color.value = HEX_RE.test(hex) ? hex.toLowerCase() : color.fallback;
    root.style.setProperty(color.cssVar, color.value);
    save(color.key, color.value === color.fallback ? null : color.value);

    color.panel.querySelectorAll(".swatch").forEach((swatch) => {
      swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color.value));
    });
    color.custom.value = color.value;

    // Warn in both pickers -- either one can be the fix.
    const hard = contrastRatio(colors.text.value ?? colors.text.fallback, colors.bg.value ?? colors.bg.fallback) < 3;
    for (const c of Object.values(colors)) if (c.note) c.note.hidden = !hard;
  }

  function buildColorPicker(kind) {
    const color = colors[kind];

    const grid = document.createElement("div");
    grid.className = "swatch-grid";
    for (const [hex, name] of PALETTE) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.dataset.color = hex;
      swatch.style.background = hex;
      swatch.title = name;
      swatch.setAttribute("aria-label", name);
      swatch.addEventListener("click", () => setColor(kind, hex));
      grid.appendChild(swatch);
    }

    const row = document.createElement("div");
    row.className = "popover-row";
    const customLabel = document.createElement("label");
    customLabel.className = "popover-btn";
    customLabel.append("Custom ");
    color.custom = document.createElement("input");
    color.custom.type = "color";
    color.custom.addEventListener("input", () => setColor(kind, color.custom.value));
    customLabel.appendChild(color.custom);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "popover-btn";
    reset.textContent = "Default";
    reset.addEventListener("click", () => setColor(kind, color.fallback));
    row.append(customLabel, reset);

    color.note = document.createElement("p");
    color.note.className = "popover-note";
    color.note.textContent = "Hard to read -- your text and background colors are too close.";
    color.note.hidden = true;

    color.panel.append(popoverTitle(color.title), grid, row, color.note);
    color.button.addEventListener("click", () => togglePopover(color.button, color.panel));
  }

  buildColorPicker("text");
  buildColorPicker("bg");
  colors.text.value = load(colors.text.key, colors.text.fallback);
  colors.bg.value = load(colors.bg.key, colors.bg.fallback);
  setColor("text", colors.text.value);
  setColor("bg", colors.bg.value);
})();
