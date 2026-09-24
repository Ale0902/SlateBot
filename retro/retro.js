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

  // ---- Message box ----
  // The text sits centered in a taller frame (see .input-wrap in retro.css);
  // a click anywhere in the frame, around it, still types in it.
  const inputFrame = input.closest(".input-wrap");
  inputFrame.addEventListener("mousedown", (e) => {
    if (e.target !== inputFrame) return;
    e.preventDefault();
    input.focus();
  });

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

  // ---- Buddy icons ----
  // Pixel art by Kenney, CC0 -- see icons/CREDITS.txt. Yours comes from his
  // Tiny Dungeon characters (or an upload); Slate Bot's from the robots,
  // aliens and the like in icons/bot/. Each sits on a colored tile like an
  // old buddy icon.
  const USER_ICONS = [
    { id: "wizard", label: "Wizard", bg: "#2b3a67" },
    { id: "knight", label: "Knight", bg: "#4a6fa5" },
    { id: "viking", label: "Viking", bg: "#8a3b2b" },
    { id: "princess", label: "Princess", bg: "#f27a9b" },
    { id: "ranger", label: "Ranger", bg: "#2f6b3a" },
    { id: "barbarian", label: "Barbarian", bg: "#c9892b" },
    { id: "dwarf", label: "Dwarf", bg: "#5a4a8a" },
    { id: "elder", label: "Elder", bg: "#008080" },
    { id: "adventurer", label: "Adventurer", bg: "#1f3fd0" },
    { id: "cyclops", label: "Cyclops", bg: "#6b2fa0" },
    { id: "slime", label: "Slime", bg: "#13295b" },
    { id: "ghost", label: "Ghost", bg: "#2b2b2b" },
    { id: "crab", label: "Crab", bg: "#3a8fb7" },
    { id: "bat", label: "Bat", bg: "#4b2e5e" },
    { id: "spider", label: "Spider", bg: "#7a7a52" },
    { id: "mimic", label: "Mimic", bg: "#2a5a4a" },
  ];

  const BOT_ICONS = [
    { id: "robot", label: "Robot", bg: "#13295b" },
    { id: "robot-mini", label: "Little robot", bg: "#2b3a67" },
    { id: "drone", label: "Drone", bg: "#4a6fa5" },
    { id: "spike-bot", label: "Spike bot", bg: "#2b2b2b" },
    { id: "alien-green", label: "Green alien", bg: "#1f3fd0" },
    { id: "alien-blue", label: "Blue alien", bg: "#6b2fa0" },
    { id: "alien-pink", label: "Pink alien", bg: "#008080" },
    { id: "alien-yellow", label: "Yellow alien", bg: "#8a3b2b" },
    { id: "astronaut", label: "Astronaut", bg: "#13295b" },
    { id: "block", label: "Block buddy", bg: "#3a8fb7" },
    { id: "invader-yellow", label: "Yellow invader", bg: "#2b2b2b" },
    { id: "invader-blue", label: "Blue invader", bg: "#13295b" },
    { id: "invader-green", label: "Green invader", bg: "#2b3a67" },
    { id: "computer", label: "Computer", bg: "#2f6b3a" },
    { id: "wizard", label: "Wizard", bg: "#2b3a67" },
  ];

  // The picture area of a buddy icon and of a picker tile (see retro.css).
  const BUDDY_FRAME = 64;
  const PICKER_FRAME = 48;

  // A pixel drawing on its colored tile, drawn at the largest whole multiple
  // of its own size that fits -- so every pixel stays crisp -- and centered.
  function pixelTile(src, bg, frame) {
    const tile = document.createElement("span");
    tile.className = "icon-tile";
    tile.style.background = bg;
    const img = document.createElement("img");
    img.alt = "";
    img.style.width = img.style.height = "0"; // sized once its pixels are known
    img.addEventListener("load", () => {
      const scale = Math.max(1, Math.floor(frame / Math.max(img.naturalWidth, img.naturalHeight)));
      img.style.width = `${img.naturalWidth * scale}px`;
      img.style.height = `${img.naturalHeight * scale}px`;
    });
    img.src = src;
    tile.appendChild(img);
    return tile;
  }

  // One buddy icon -- a button showing the current pick -- and the picker it
  // opens. `custom` (yours only) returns an uploaded icon, if there is one.
  function buddyIcon({ button, panel, grid, icons, folder, key, fallback, custom = () => null, onOpen }) {
    let choice = load(key, fallback);

    function art(id, frame) {
      if (id === "custom" && custom()) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = custom();
        return img;
      }
      const icon = icons.find((i) => i.id === id) ?? icons[0];
      return pixelTile(`icons/${folder}${icon.id}.png`, icon.bg, frame);
    }

    function render() {
      // A pick that no longer exists (like an earlier icon set's) goes back
      // to the default.
      if (choice === "custom" ? !custom() : !icons.some((i) => i.id === choice)) {
        choice = fallback;
        save(key, null);
      }
      button.replaceChildren(art(choice, BUDDY_FRAME));

      const choices = icons.map(({ id, label }) => ({ id, label }));
      if (custom()) choices.push({ id: "custom", label: "Your uploaded icon" });
      grid.replaceChildren(
        ...choices.map(({ id, label }) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "icon-choice";
          option.title = label;
          option.setAttribute("aria-label", label);
          option.setAttribute("aria-pressed", String(id === choice));
          option.appendChild(art(id, PICKER_FRAME));
          option.addEventListener("click", () => {
            pick(id);
            closePopover(false);
            input.focus();
          });
          return option;
        })
      );
    }

    function pick(id) {
      choice = id;
      save(key, id === fallback ? null : id);
      render();
    }

    button.addEventListener("click", () => {
      onOpen?.();
      togglePopover(button, panel);
    });
    render();
    return { pick };
  }

  // Yours: one of the characters, or an upload.
  const CUSTOM_ICON_KEY = "celta-chat.retroCustomIcon";
  // Uploads are center-cropped to a square this size, about 10KB saved.
  const CUSTOM_ICON_SIZE = 64;
  const iconFile = $("iconFile");
  const iconNote = $("iconNote");
  let customIcon = load(CUSTOM_ICON_KEY, null);

  function showIconNote(text) {
    iconNote.textContent = text;
    iconNote.hidden = !text;
  }

  const myIcon = buddyIcon({
    button: $("myIconBtn"),
    panel: $("iconPicker"),
    grid: $("iconGrid"),
    icons: USER_ICONS,
    folder: "",
    key: "celta-chat.retroIcon",
    fallback: "wizard",
    custom: () => customIcon,
    onOpen: () => showIconNote(""),
  });

  // Slate Bot's.
  buddyIcon({
    button: $("botIconBtn"),
    panel: $("botIconPicker"),
    grid: $("botIconGrid"),
    icons: BOT_ICONS,
    folder: "bot/",
    key: "celta-chat.retroBotIcon",
    fallback: "robot",
  });

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

  $("iconUploadBtn").addEventListener("click", () => iconFile.click());

  iconFile.addEventListener("change", async () => {
    const file = iconFile.files?.[0];
    iconFile.value = ""; // so picking the same file again still fires "change"
    if (!file) return;
    // Same limit as the chat's own uploads (MAX_UPLOAD_MB in src/main.ts).
    if (file.size > 25 * 1024 * 1024) {
      showIconNote("That image is too big -- the limit is 25 MB.");
      return;
    }
    try {
      const dataUrl = await readIcon(file);
      customIcon = dataUrl;
      myIcon.pick("custom");
      showIconNote(save(CUSTOM_ICON_KEY, dataUrl) ? "" : "Set for now, but it couldn't be saved for next time.");
    } catch {
      showIconNote("Couldn't open that image -- try a JPEG, PNG, WebP or GIF.");
    }
  });

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
