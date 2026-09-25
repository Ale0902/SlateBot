// Extras for the retro skin, on top of ../dist/main.js: text size, your
// buddy icon, and the color of your text and its background. All of it is
// saved in this browser only.
(() => {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const input = $("input");
  const appWindow = document.querySelector(".window");
  const titlebar = document.querySelector(".titlebar");
  const taskButton = $("taskButton");

  // Desktop-style window controls. The native resize handle handles growth;
  // the title bar supplies movement without changing the chat's layout.
  if (appWindow && titlebar) {
    let drag = null;
    let resize = null;

    function usableHeight() {
      const taskbarHeight = parseFloat(getComputedStyle(root).getPropertyValue("--taskbar-height")) || 0;
      return innerHeight - taskbarHeight;
    }

    function minimumSize() {
      return {
        width: Math.min(620, innerWidth - 16),
        height: Math.min(420, usableHeight() - 16),
      };
    }

    function restoreFromMaximized() {
      if (!appWindow.classList.contains("is-maximized")) return;
      appWindow.classList.remove("is-maximized");
      appWindow.style.width = "";
      appWindow.style.height = "";
      appWindow.style.right = "";
      appWindow.style.bottom = "";
      appWindow.style.left = "0px";
      appWindow.style.top = "0px";
      appWindow.style.transform = "none";
      const rect = appWindow.getBoundingClientRect();
      appWindow.style.left = `${Math.max(8, (innerWidth - rect.width) / 2)}px`;
      appWindow.style.top = `${Math.max(8, (usableHeight() - rect.height) / 2)}px`;
    }

    function toggleMaximized() {
      if (appWindow.classList.contains("is-maximized")) {
        restoreFromMaximized();
        $("maximizeBtn")?.setAttribute("aria-label", "Maximize window");
        return;
      }
      appWindow.classList.remove("is-minimized");
      appWindow.style.width = "";
      appWindow.style.height = "";
      appWindow.style.left = "";
      appWindow.style.top = "";
      appWindow.style.right = "";
      appWindow.style.bottom = "";
      appWindow.style.transform = "";
      appWindow.classList.add("is-maximized");
      $("maximizeBtn")?.setAttribute("aria-label", "Restore window");
    }

    titlebar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      if (appWindow.classList.contains("is-minimized") || appWindow.classList.contains("is-maximized")) return;
      const rect = appWindow.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      titlebar.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    titlebar.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = appWindow.getBoundingClientRect();
      const left = Math.min(Math.max(8, event.clientX - drag.offsetX), innerWidth - rect.width - 8);
      const top = Math.min(Math.max(8, event.clientY - drag.offsetY), usableHeight() - rect.height - 8);
      appWindow.style.left = `${left}px`;
      appWindow.style.top = `${top}px`;
      appWindow.style.transform = "none";
    });

    function stopDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      titlebar.releasePointerCapture(event.pointerId);
    }

    titlebar.addEventListener("pointerup", stopDrag);
    titlebar.addEventListener("pointercancel", stopDrag);

    titlebar.addEventListener("dblclick", (event) => {
      if (event.target.closest("button") || event.target.closest("#chatTitle")) return;
      if (appWindow.classList.contains("is-minimized")) {
        appWindow.classList.remove("is-minimized");
        resetWindowAnimation();
      }
      toggleMaximized();
      event.preventDefault();
    });

    for (const handle of appWindow.querySelectorAll(".resize-handle")) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || appWindow.classList.contains("is-minimized") || appWindow.classList.contains("is-maximized")) return;
        const rect = appWindow.getBoundingClientRect();
        resize = { pointerId: event.pointerId, direction: handle.dataset.resize, rect, startX: event.clientX, startY: event.clientY };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      handle.addEventListener("pointermove", (event) => {
        if (!resize || resize.pointerId !== event.pointerId) return;
        const { rect, direction, startX, startY } = resize;
        const min = minimumSize();
        const maxWidth = innerWidth - 16;
        const maxHeight = usableHeight() - 16;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        let width = rect.width + (direction.includes("e") ? deltaX : -deltaX);
        let height = rect.height + (direction.includes("s") ? deltaY : -deltaY);
        width = Math.max(min.width, Math.min(maxWidth, width));
        height = Math.max(min.height, Math.min(maxHeight, height));
        const left = direction.includes("w") ? rect.right - width : rect.left;
        const top = direction.includes("n") ? rect.bottom - height : rect.top;
        appWindow.style.width = `${width}px`;
        appWindow.style.height = `${height}px`;
        appWindow.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, left))}px`;
        appWindow.style.top = `${Math.max(8, Math.min(usableHeight() - height - 8, top))}px`;
        appWindow.style.transform = "none";
      });

      function stopResize(event) {
        if (!resize || resize.pointerId !== event.pointerId) return;
        resize = null;
        handle.releasePointerCapture(event.pointerId);
      }

      handle.addEventListener("pointerup", stopResize);
      handle.addEventListener("pointercancel", stopResize);
    }

    function resetWindowAnimation() {
      appWindow.classList.remove("is-minimizing", "is-closing", "is-restoring");
      appWindow.style.removeProperty("--minimize-x");
      appWindow.style.removeProperty("--minimize-y");
      appWindow.style.removeProperty("--restore-x");
      appWindow.style.removeProperty("--restore-y");
      appWindow.style.opacity = "";
      appWindow.style.pointerEvents = "";
    }

    function animateToTaskbar(done) {
      if (!taskButton) return done();
      const windowRect = appWindow.getBoundingClientRect();
      const taskRect = taskButton.getBoundingClientRect();
      const x = taskRect.left + taskRect.width / 2 - (windowRect.left + windowRect.width / 2);
      const y = taskRect.top + taskRect.height / 2 - (windowRect.top + windowRect.height / 2);
      appWindow.style.left = `${windowRect.left}px`;
      appWindow.style.top = `${windowRect.top}px`;
      appWindow.style.setProperty("--minimize-x", `${x}px`);
      appWindow.style.setProperty("--minimize-y", `${y}px`);
      appWindow.style.transform = "none";
      appWindow.classList.add("is-minimizing");
      window.setTimeout(() => {
        appWindow.classList.remove("is-minimizing");
        done();
      }, 260);
    }

    $("minimizeBtn")?.addEventListener("click", () => {
      if (appWindow.classList.contains("is-minimizing")) return;
      if (!appWindow.classList.contains("is-minimized") && appWindow.classList.contains("is-maximized")) {
        appWindow.classList.remove("is-maximized");
        appWindow.style.left = "";
        appWindow.style.top = "";
        appWindow.style.width = "";
        appWindow.style.height = "";
        appWindow.style.transform = "";
      }
      if (appWindow.classList.contains("is-minimized")) {
        appWindow.classList.remove("is-minimized");
        resetWindowAnimation();
        $("minimizeBtn").setAttribute("aria-label", "Minimize window");
        taskButton?.setAttribute("aria-pressed", "true");
        return;
      }
      animateToTaskbar(() => {
        appWindow.classList.add("is-minimized");
        resetWindowAnimation();
        $("minimizeBtn").setAttribute("aria-label", "Restore window");
        taskButton?.setAttribute("aria-pressed", "false");
      });
    });

    $("maximizeBtn")?.addEventListener("click", () => {
      toggleMaximized();
    });

    $("closeBtn")?.addEventListener("click", () => {
      if (appWindow.classList.contains("is-closing")) return;
      appWindow.classList.add("is-closing");
      window.setTimeout(() => {
        appWindow.hidden = true;
        appWindow.classList.remove("is-closing");
        appWindow.style.opacity = "";
        taskButton?.setAttribute("aria-pressed", "false");
        $("desktopIcon")?.focus();
      }, 180);
    });

    $("desktopIcon")?.addEventListener("dblclick", () => openWindow(true));

    function openWindow(fromDesktop = false) {
      resetWindowAnimation();
      appWindow.hidden = false;
      appWindow.classList.remove("is-minimized");
      $("minimizeBtn")?.setAttribute("aria-label", "Minimize window");
      taskButton?.setAttribute("aria-pressed", "true");
      if (!fromDesktop) return;

      const icon = $("desktopIcon");
      if (!icon) return;
      const windowRect = appWindow.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      appWindow.style.setProperty("--restore-x", `${iconRect.left + iconRect.width / 2 - (windowRect.left + windowRect.width / 2)}px`);
      appWindow.style.setProperty("--restore-y", `${iconRect.top + iconRect.height / 2 - (windowRect.top + windowRect.height / 2)}px`);
      appWindow.classList.add("is-restoring");
      window.setTimeout(() => {
        appWindow.classList.remove("is-restoring");
        appWindow.style.removeProperty("--restore-x");
        appWindow.style.removeProperty("--restore-y");
      }, 260);
    }

    taskButton?.addEventListener("click", () => {
      if (appWindow.hidden) openWindow();
      else if (appWindow.classList.contains("is-minimized")) openWindow();
      else appWindow.focus();
    });

    function updateClock() {
      const clock = $("clock");
      if (clock) clock.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
    }

    updateClock();
    window.setInterval(updateClock, 30_000);
  }

  function load(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // Free Unsplash photographs give the chat window a period desktop mood
  // without bundling copyrighted Windows wallpaper into the project.
  const SCENE_KEY = "celta-chat.retroScene";
  const SCENES = [
    {
      id: "bliss",
      label: "Bliss-inspired",
      image: "url(\"https://images.unsplash.com/photo-1499346030926-9a72daac6c63?auto=format&fit=crop&w=2200&q=85\")",
      position: "center",
    },
    {
      id: "grass",
      label: "XP grass",
      image: "url(\"https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=2200&q=85\")",
      position: "center",
    },
    {
      id: "aero",
      label: "Aero sky",
      image: "url(\"https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=2200&q=85\")",
      position: "center",
    },
    {
      id: "midnight",
      label: "Midnight glass",
      image: "url(\"https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=2200&q=85\")",
      position: "center",
    },
    {
      id: "forest",
      label: "Green desktop",
      image: "url(\"https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=2200&q=85\")",
      position: "center",
    },
  ];

  const scenePicker = $("scenePicker");
  if (scenePicker) {
    for (const scene of SCENES) scenePicker.add(new Option(scene.label, scene.id));

    function setScene(id) {
      const scene = SCENES.find((candidate) => candidate.id === id) ?? SCENES[0];
      scenePicker.value = scene.id;
      root.style.setProperty("--scene-image", scene.image);
      root.style.setProperty("--scene-position", scene.position);
      save(SCENE_KEY, scene.id === SCENES[0].id ? null : scene.id);
    }

    setScene(load(SCENE_KEY, SCENES[0].id));
    scenePicker.addEventListener("change", () => setScene(scenePicker.value));
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

  // ---- Desktop icons ----
  // They behave like XP icons: a click selects one, a click on the empty
  // desktop clears that, and dragging one drops it onto the nearest free
  // grid spot, which is remembered. They start in a column at the top left.
  // Double-clicking opens it (the window above; the Recycle Bin in main.js).
  const desktop = $("desktop");
  const desktopIcons = desktop ? Array.from(desktop.querySelectorAll(".desktop-icon")) : [];
  if (desktop && desktopIcons.length) {
    const ICON_POS_KEY = "celta-chat.retroIconPositions";
    const GRID_X = 100;
    const GRID_Y = 100;
    const MARGIN = 8;
    const DRAG_THRESHOLD = 4; // pixels, as in Windows
    let iconDrag = null;

    let positions = {};
    try {
      const saved = JSON.parse(load(ICON_POS_KEY, "{}"));
      if (saved && typeof saved === "object") positions = saved;
    } catch {
      // Damaged saved positions just leave the icons in their starting spots.
    }
    save("celta-chat.retroIconPos", null); // from when there was one icon

    function clampIcon(icon, left, top) {
      const maxLeft = Math.max(MARGIN, desktop.clientWidth - icon.offsetWidth - MARGIN);
      const maxTop = Math.max(MARGIN, desktop.clientHeight - icon.offsetHeight - MARGIN);
      return {
        left: Math.min(Math.max(MARGIN, left), maxLeft),
        top: Math.min(Math.max(MARGIN, top), maxTop),
      };
    }

    function placeIcon(icon, left, top) {
      const pos = clampIcon(icon, left, top);
      icon.style.left = `${pos.left}px`;
      icon.style.top = `${pos.top}px`;
      return pos;
    }

    function iconPos(icon) {
      return { left: parseFloat(icon.style.left) || MARGIN, top: parseFloat(icon.style.top) || MARGIN };
    }

    function snapToGrid(left, top) {
      return {
        left: MARGIN + Math.round((left - MARGIN) / GRID_X) * GRID_X,
        top: MARGIN + Math.round((top - MARGIN) / GRID_Y) * GRID_Y,
      };
    }

    function spotTaken(icon, pos) {
      return desktopIcons.some((other) => {
        if (other === icon) return false;
        const at = iconPos(other);
        return Math.abs(at.left - pos.left) < GRID_X / 2 && Math.abs(at.top - pos.top) < GRID_Y / 2;
      });
    }

    function selectIcon(icon) {
      for (const each of desktopIcons) each.classList.toggle("is-selected", each === icon);
    }

    desktopIcons.forEach((icon, index) => {
      const saved = positions[icon.id];
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) placeIcon(icon, saved.left, saved.top);
      else placeIcon(icon, MARGIN, MARGIN + index * GRID_Y);

      icon.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        selectIcon(icon);
        icon.focus();
        const rect = icon.getBoundingClientRect();
        const desktopRect = desktop.getBoundingClientRect();
        iconDrag = {
          icon,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          from: iconPos(icon),
          offsetX: event.clientX - rect.left + desktopRect.left,
          offsetY: event.clientY - rect.top + desktopRect.top,
          moved: false,
        };
        icon.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      icon.addEventListener("pointermove", (event) => {
        if (!iconDrag || iconDrag.icon !== icon || iconDrag.pointerId !== event.pointerId) return;
        if (!iconDrag.moved) {
          const distance = Math.hypot(event.clientX - iconDrag.startX, event.clientY - iconDrag.startY);
          if (distance < DRAG_THRESHOLD) return;
          iconDrag.moved = true;
          icon.classList.add("is-dragging");
        }
        placeIcon(icon, event.clientX - iconDrag.offsetX, event.clientY - iconDrag.offsetY);
      });

      function stopIconDrag(event) {
        if (!iconDrag || iconDrag.icon !== icon || iconDrag.pointerId !== event.pointerId) return;
        const { moved, from } = iconDrag;
        iconDrag = null;
        icon.releasePointerCapture(event.pointerId);
        icon.classList.remove("is-dragging");
        if (!moved) return;
        const current = iconPos(icon);
        const snapped = snapToGrid(current.left, current.top);
        let pos = clampIcon(icon, snapped.left, snapped.top);
        // Dropped on another icon: it goes back where it came from.
        if (spotTaken(icon, pos)) pos = from;
        positions[icon.id] = placeIcon(icon, pos.left, pos.top);
        save(ICON_POS_KEY, JSON.stringify(positions));
      }

      icon.addEventListener("pointerup", stopIconDrag);
      icon.addEventListener("pointercancel", stopIconDrag);

      // Enter opens it too, as on a real desktop.
      icon.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        icon.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });

      icon.addEventListener("blur", () => icon.classList.remove("is-selected"));
    });

    desktop.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".desktop-icon")) selectIcon(null);
    });

    // Keep them on screen when the browser window shrinks.
    window.addEventListener("resize", () => {
      for (const icon of desktopIcons) {
        const at = iconPos(icon);
        placeIcon(icon, at.left, at.top);
      }
    });
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
