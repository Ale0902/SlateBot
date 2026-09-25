type Role = "user" | "assistant";
type MessageRole = Role | "bot";

interface ChatMessage {
  role: Role;
  content: string;
  chartUrl?: string;
  // How long the reply took, from pressing Send to the answer arriving.
  durationMs?: number;
  imageUrl?: string;
  // A small copy (data: URL) of an image the user attached. Only this is
  // saved -- the model sees the full-size image on that one turn, and later
  // turns just see its reply about it.
  image?: string;
}

interface Attachment {
  // What the model gets: a base64 JPEG, no "data:" prefix.
  base64: string;
  // What the chat shows and saves.
  thumbnail: string;
}

interface SavedChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  // Every URL a tool returned in this chat, so a later "what's your source"
  // can be verified against something found in an earlier turn.
  seenUrls: string[];
  updatedAt: number;
  // The user named this chat, so its first message doesn't title it.
  renamed?: boolean;
}

// A chat in the Recycle Bin, until it's restored or deleted for good.
interface DeletedChat extends SavedChat {
  deletedAt: number;
}

interface Config {
  useMock: boolean;
  bridgeUrl: string;
  model: string;
  numCtx: number;
  numGpu: number | null;
  botName: string;
  // The model as users see it (bottom left and in About).
  modelLabel: string;
}

// ---- Config ----
// The page talks to server/bridge.py (npm start), which runs the MCP tool
// server and forwards chat requests to Ollama. The Ollama URL lives there
// (OLLAMA_URL, default http://10.7.163.103:11434).

// When the bridge serves the page -- at localhost:8765, or a public domain
// in front of it -- it's the page's own address. A copy opened some other
// way (Live Server on 5500+, or as a file) uses the local bridge.
const LOCAL_BRIDGE = "http://127.0.0.1:8765";
const SERVED_BY_BRIDGE = /^https?:$/.test(location.protocol) && !/^55\d\d$/.test(location.port);

const CONFIG: Config = {
  useMock: false,
  bridgeUrl: SERVED_BY_BRIDGE ? location.origin : LOCAL_BRIDGE,
  // gemma3:12b plus "PARAMETER num_gpu 49", created on the VM. Left to itself
  // Ollama only uses the GTX 1660 and runs half the model on the CPU; all 49
  // layers fit across both cards and write replies ~3x faster. The Discord
  // bot uses this same model, so the two never force a reload on each other.
  model: "gemma3-12b-gpu",
  numCtx: 8192,
  // Per-request layer override -- null leaves it to the model's own setting.
  // Sending a value that differs from what's loaded makes Ollama reload (~7s).
  numGpu: null,
  botName: "Slate Bot",
  modelLabel: "Gemma 3 12B",
};

// Earlier question/answer pairs sent back to the model, oldest dropped first.
const MAX_HISTORY_MESSAGES = 16;

// Chats are saved in this browser only. Oldest drop off past the cap.
const CHATS_KEY = "celta-chat.chats";
const RECYCLE_BIN_KEY = "celta-chat.recycleBin";
const MAX_SAVED_CHATS = 50;
const MAX_TITLE_LENGTH = 60;
const GREETING = "Hi! How can I help you today?";
// gemma3 scales every image to 896x896 before looking at it, so anything
// bigger is only a slower upload and encode for no extra detail.
const MODEL_IMAGE_SIZE = 896;
// Sharp enough in the chat, small enough that a few saved images don't eat
// the ~5MB localStorage has for every chat.
const THUMBNAIL_SIZE = 480;
// Every upload is shrunk here before it's sent or saved, but a huge file can
// still freeze the tab while it decodes, so there's a cap on what's opened.
const MAX_UPLOAD_MB = 25;

// Why a picked file can't be used as an image, or null if it can.
function uploadProblem(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Only images can be uploaded.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return `That image is too big -- the limit is ${MAX_UPLOAD_MB} MB.`;
  }
  return null;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const chat = $<HTMLElement>("chat");
const form = $<HTMLFormElement>("form");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("sendBtn");
const suggestions = $<HTMLDivElement>("suggestions");
const recents = $<HTMLDivElement>("recents");
const chatTitle = $<HTMLSpanElement>("chatTitle");
const botStatus = document.getElementById("botStatus");
const newChatBtn = $<HTMLButtonElement>("newChatBtn");
const workspace = $<HTMLDivElement>("workspace");
const attachBtn = $<HTMLButtonElement>("attachBtn");
const fileInput = $<HTMLInputElement>("fileInput");
const attachmentPreview = $<HTMLDivElement>("attachmentPreview");

function setBotStatus(status: string): void {
  if (botStatus) botStatus.textContent = status;
}

function readChatList(key: string): SavedChat[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is SavedChat =>
          typeof c?.id === "string" && typeof c.title === "string" && Array.isArray(c.messages)
      )
      .map((c) => ({ ...c, seenUrls: Array.isArray(c.seenUrls) ? c.seenUrls : [], updatedAt: Number(c.updatedAt) || 0 }));
  } catch {
    return [];
  }
}

function loadChats(): SavedChat[] {
  return readChatList(CHATS_KEY).sort((a, b) => b.updatedAt - a.updatedAt);
}

function loadRecycleBin(): DeletedChat[] {
  return readChatList(RECYCLE_BIN_KEY)
    .map((c) => ({ ...c, deletedAt: Number((c as Partial<DeletedChat>).deletedAt) || 0 }))
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

// Saves a newest-first list, keeping what fits: if storage is full, the
// oldest entries are dropped until it does. Returns what was kept.
function persistList<T>(key: string, list: T[]): T[] {
  list = list.slice(0, MAX_SAVED_CHATS);
  for (;;) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
      return list;
    } catch {
      if (list.length <= 1) return list; // storage blocked entirely -- it just won't persist
      list = list.slice(0, -1);
    }
  }
}

function saveChats(): void {
  chats = persistList(CHATS_KEY, chats);
}

function saveRecycleBin(): void {
  recycleBin = persistList(RECYCLE_BIN_KEY, recycleBin);
}

function newChat(): SavedChat {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: "New chat",
    messages: [],
    seenUrls: [],
    updatedAt: Date.now(),
  };
}

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_LENGTH ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : oneLine;
}

// Newest first. A chat is only saved once it has a message, so clicking
// "New chat" repeatedly doesn't fill Recents with empty entries.
let chats = loadChats();
// Deleted chats, newest deletion first.
let recycleBin = loadRecycleBin();
// The site always opens on a fresh chat (the start view); earlier chats are
// one click away in Recents.
let activeChat: SavedChat = newChat();
let busy = false;
// The typing indicator for a reply still loading, kept so it can be put back
// if the user leaves that chat and returns before the reply arrives.
let pending: { chat: SavedChat; typing: HTMLElement } | null = null;
// Unsent text per chat, by chat id -- the text box is shared, so switching
// chats stashes what was typed and restores the other chat's draft.
const drafts = new Map<string, string>();
// The image waiting to go with the next message, and the same per-chat
// stash for it as `drafts`.
let attachment: Attachment | null = null;
const draftAttachments = new Map<string, Attachment>();

function touch(target: SavedChat): void {
  target.updatedAt = Date.now();
  chats = [target, ...chats.filter((c) => c !== target)];
  saveChats();
  renderRecents();
}

function appendImage(bubble: HTMLElement, src: string, alt: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "attachment";
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  // Chart files are deleted when the bridge stops, so older ones can be gone.
  img.addEventListener("error", () => img.remove());
  bubble.appendChild(img);
  return img;
}

// Text goes in via textContent; the (already verified) Source line becomes a link.
function fillBubble(bubble: HTMLElement, message: ChatMessage): void {
  const match = message.role === "assistant" ? SOURCE_LINE_RE.exec(message.content) : null;
  // Without punctuation the model puts after it ("...706d."), which would
  // break the link.
  const sourceUrl = match && /^https?:\/\//i.test(match[1]) ? match[1].replace(/[.,;:!?)\]]+$/, "") : null;
  bubble.textContent = sourceUrl ? stripCitation(message.content) : message.content;

  if (message.image) {
    bubble.prepend(appendImage(bubble, message.image, "Attached image"));
    bubble.classList.toggle("image-only", !message.content);
  }

  if (sourceUrl) {
    const source = document.createElement("div");
    source.className = "source";
    const link = document.createElement("a");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = sourceUrl;
    source.append("Source: ", link);
    bubble.appendChild(source);
    // An image result is already shown in full, so it gets no preview card.
    if (sourceUrl !== message.imageUrl) appendLinkPreview(bubble, sourceUrl);
  }
  if (message.imageUrl) appendImage(bubble, message.imageUrl, "Image result");
  if (message.chartUrl) appendImage(bubble, message.chartUrl, "Chart");
  if (message.durationMs !== undefined) {
    const time = document.createElement("div");
    time.className = "reply-time";
    time.textContent = `Took ${formatDuration(message.durationMs)}`;
    bubble.appendChild(time);
  }
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

// ---- Link previews ----
// The bridge reads each page's own preview tags (og:title, og:image, ...).
// Only the verified Source link is unfurled -- other URLs in a reply haven't
// been checked against what the tools returned.

interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
}

const previewCache = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(url: string): Promise<LinkPreview | null> {
  let preview = previewCache.get(url);
  if (!preview) {
    preview = requestJson<{ preview: LinkPreview | null }>(
      `/api/unfurl?url=${encodeURIComponent(url)}`,
      undefined,
      20_000
    )
      .then((data) => data.preview)
      .catch(() => {
        previewCache.delete(url); // bridge down -- try again next time
        return null;
      });
    previewCache.set(url, preview);
  }
  return preview;
}

function appendLinkPreview(bubble: HTMLElement, url: string): void {
  const card = document.createElement("a");
  card.className = "link-card";
  card.href = url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  card.hidden = true;
  bubble.appendChild(card);

  void loadPreview(url).then((preview) => {
    if (!card.isConnected) return;
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    if (preview) fillPreviewCard(card, preview);
    else fillBasicCard(card, url);
    card.hidden = false;
    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  });
}

// The page's own preview: its picture, site, title and description.
function fillPreviewCard(card: HTMLAnchorElement, preview: LinkPreview): void {
  if (preview.image) {
    const thumb = document.createElement("img");
    thumb.className = "link-card-thumb";
    thumb.src = preview.image;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.referrerPolicy = "no-referrer";
    // Many sites refuse hotlinked images -- fall back to a text-only card,
    // or to the basic one if there's no title to show either.
    thumb.addEventListener("error", () => {
      thumb.remove();
      if (!preview.title) fillBasicCard(card, preview.url);
    });
    card.appendChild(thumb);
  }

  const text = document.createElement("div");
  text.className = "link-card-text";
  for (const [className, value] of [
    ["link-card-site", preview.siteName],
    ["link-card-title", preview.title],
    ["link-card-desc", preview.description],
  ]) {
    if (!value) continue;
    const line = document.createElement("span");
    line.className = className;
    line.textContent = value;
    text.appendChild(line);
  }
  card.appendChild(text);
}

// For a page that can't be previewed -- plenty of sites turn away automated
// requests, so the bridge never sees their preview tags -- the site's name,
// with its icon when it has one. The icon loads straight from the site,
// like any picture in an answer.
function fillBasicCard(card: HTMLAnchorElement, url: string): void {
  let site: URL;
  try {
    site = new URL(url);
  } catch {
    card.remove();
    return;
  }
  const icon = document.createElement("img");
  icon.className = "link-card-icon";
  icon.src = `${site.origin}/favicon.ico`;
  icon.alt = "";
  icon.referrerPolicy = "no-referrer";
  icon.addEventListener("error", () => icon.remove());

  const text = document.createElement("div");
  text.className = "link-card-text";
  const name = document.createElement("span");
  name.className = "link-card-title";
  name.textContent = site.hostname.replace(/^www\./, "");
  text.appendChild(name);

  card.classList.add("is-basic");
  card.replaceChildren(icon, text);
}

function addMessage(role: MessageRole, message: ChatMessage, extraClass = ""): void {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role} ${extraClass}`.trim();
  wrap.innerHTML = `<div class="avatar">${role === "user" ? "You" : "AI"}</div><div class="bubble"></div>`;
  fillBubble(wrap.querySelector<HTMLElement>(".bubble")!, message);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function renderChat(target: SavedChat): void {
  chat.innerHTML = "";
  addMessage("bot", { role: "assistant", content: GREETING }, "greeting");
  target.messages.forEach((message) => addMessage(message.role === "user" ? "user" : "bot", message));
  if (pending?.chat === target) chat.appendChild(pending.typing);
  updateSuggestions();
  workspace.classList.toggle("is-empty", !target.messages.length);
  chatTitle.textContent = target.title;
  chat.scrollTop = chat.scrollHeight;
}

// The example prompts are only for someone who hasn't sent anything yet --
// once any chat has been saved, they're gone for good, new chats included.
function updateSuggestions(): void {
  suggestions.hidden = chats.length > 0;
}

// True while the list is being rebuilt, when a text box being renamed in
// it is briefly taken out -- that isn't the user clicking away.
let redrawingRecents = false;

function renderRecents(): void {
  const keepFocus = recentRename !== null && document.activeElement === recentRename.field;
  redrawingRecents = true;
  recents.innerHTML = "";
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No chats yet";
    recents.appendChild(empty);
  }
  chats.forEach((saved) => {
    if (recentRename?.target === saved) {
      recents.appendChild(recentRename.field);
      return;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-item";
    item.classList.toggle("active", saved === activeChat);
    item.textContent = saved.title;
    item.title = saved.title;
    item.addEventListener("click", () => openChat(saved));
    // The first click of the two already opened it -- rename it in place.
    item.addEventListener("dblclick", () => startRename());
    item.addEventListener("keydown", (e) => {
      if (e.key !== "Delete") return;
      e.preventDefault();
      deleteChat(saved);
    });
    // Also covers the keyboard's menu key and Shift+F10, which have no
    // pointer position -- the menu then opens at the item.
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const box = item.getBoundingClientRect();
      const fromKeyboard = e.clientX === 0 && e.clientY === 0;
      openContextMenu(saved, fromKeyboard ? box.left + 12 : e.clientX, fromKeyboard ? box.bottom : e.clientY);
    });
    recents.appendChild(item);
  });
  redrawingRecents = false;
  if (keepFocus) recentRename?.field.focus();

  newChatBtn.classList.toggle("active", !chats.includes(activeChat));
}

// ---- Renaming ----
// The title in the top bar edits in place: click it (or Enter/F2 on it, or
// double-click a chat in Recents), type, then Enter or click away to save.
// Escape cancels, and a blank name keeps the old one.

let renaming: { target: SavedChat; before: string } | null = null;

function startRename(): void {
  if (renaming) return;
  renaming = { target: activeChat, before: activeChat.title };
  try {
    chatTitle.contentEditable = "plaintext-only";
  } catch {
    chatTitle.contentEditable = "true"; // browsers without plaintext-only
  }
  chatTitle.classList.add("editing");
  chatTitle.focus();
  getSelection()?.selectAllChildren(chatTitle);
}

function finishRename(save: boolean): void {
  if (!renaming) return;
  const { target } = renaming;
  renaming = null;
  chatTitle.contentEditable = "false";
  chatTitle.classList.remove("editing");
  if (save) renameChat(target, chatTitle.textContent ?? "");
  chatTitle.textContent = activeChat.title;
}

// Shared by both ways of renaming. A blank name keeps the old one.
function renameChat(target: SavedChat, text: string): void {
  const title = makeTitle(text);
  if (!title || title === target.title) return;
  target.title = title;
  target.renamed = true;
  // Not touch(): a new name isn't new activity, so it keeps its place.
  if (chats.includes(target)) saveChats();
  renderRecents();
  if (target === activeChat && !renaming) chatTitle.textContent = title;
}

// ---- Renaming from Recents: right-click a chat, pick Rename, and its entry
// turns into a text box right there ----

const contextMenu = document.createElement("div");
contextMenu.className = "context-menu";
contextMenu.setAttribute("role", "menu");
contextMenu.hidden = true;
const renameMenuItem = document.createElement("button");
renameMenuItem.type = "button";
renameMenuItem.setAttribute("role", "menuitem");
renameMenuItem.textContent = "Rename";
contextMenu.appendChild(renameMenuItem);
const deleteMenuItem = document.createElement("button");
deleteMenuItem.type = "button";
deleteMenuItem.setAttribute("role", "menuitem");
deleteMenuItem.textContent = "Delete";
contextMenu.appendChild(deleteMenuItem);
document.body.appendChild(contextMenu);

let menuChat: SavedChat | null = null;
// The chat being renamed in Recents, and its text box -- kept so a redraw
// of the list (say, a reply arriving) doesn't throw away the edit.
let recentRename: { target: SavedChat; field: HTMLInputElement } | null = null;

function openContextMenu(target: SavedChat, x: number, y: number): void {
  menuChat = target;
  // A chat still waiting on a reply can't go yet -- the reply would bring it back.
  deleteMenuItem.disabled = pending?.chat === target;
  deleteMenuItem.title = deleteMenuItem.disabled ? "Wait for the reply to finish" : "";
  contextMenu.hidden = false;
  // Keep it on screen near the edges.
  const { width, height } = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  contextMenu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
  renameMenuItem.focus();
}

function closeContextMenu(): void {
  contextMenu.hidden = true;
  menuChat = null;
}

renameMenuItem.addEventListener("click", () => {
  const target = menuChat;
  closeContextMenu();
  if (target) startRecentRename(target);
});

deleteMenuItem.addEventListener("click", () => {
  const target = menuChat;
  closeContextMenu();
  if (target) deleteChat(target);
  input.focus();
});

// ---- Deleting: a deleted chat goes to the Recycle Bin, where it can be
// restored, or deleted again to be gone for good ----

function deleteChat(target: SavedChat): void {
  if (pending?.chat === target || !chats.includes(target)) return;
  chats = chats.filter((c) => c !== target);
  saveChats();
  recycleBin = [{ ...target, deletedAt: Date.now() }, ...recycleBin];
  saveRecycleBin();
  drafts.delete(target.id);
  draftAttachments.delete(target.id);
  if (recentRename?.target === target) recentRename = null;
  if (renaming?.target === target) finishRename(false);
  if (target === activeChat) openBlankChat();
  else renderRecents();
  renderRecycleBin();
}

function restoreChat(id: string): void {
  const entry = recycleBin.find((c) => c.id === id);
  if (!entry) return;
  recycleBin = recycleBin.filter((c) => c !== entry);
  saveRecycleBin();
  const { deletedAt: _, ...restored } = entry;
  // Back in its old place: Recents is ordered by last activity.
  chats = [...chats, restored].sort((a, b) => b.updatedAt - a.updatedAt);
  saveChats();
  renderRecents();
  updateSuggestions();
  renderRecycleBin();
}

function purgeChat(id: string): void {
  const entry = recycleBin.find((c) => c.id === id);
  if (!entry) return;
  if (!confirm(`Are you sure you want to permanently delete "${entry.title}"?`)) return;
  recycleBin = recycleBin.filter((c) => c !== entry);
  saveRecycleBin();
  renderRecycleBin();
}

function emptyRecycleBin(): void {
  if (!recycleBin.length) return;
  const what = recycleBin.length === 1 ? `"${recycleBin[0].title}"` : `these ${recycleBin.length} chats`;
  if (!confirm(`Are you sure you want to permanently delete ${what}?`)) return;
  recycleBin = [];
  saveRecycleBin();
  renderRecycleBin();
}

// The Recycle Bin's icon and window only exist in the retro theme; in the
// other theme deleted chats still wait in the bin, to restore from there.
const recycleBinIcon = document.getElementById("recycleBinIcon");
const recycleBinDialog = document.getElementById("recycleBinDialog") as HTMLDialogElement | null;
const recycleBinList = document.getElementById("recycleBinList");
const recycleBinEmptyNote = document.getElementById("recycleBinEmptyNote");
const recycleBinEmptyBtn = document.getElementById("recycleBinEmptyBtn") as HTMLButtonElement | null;
const recycleBinCount = document.getElementById("recycleBinCount");

function renderRecycleBin(): void {
  const full = recycleBin.length > 0;
  recycleBinIcon?.classList.toggle("is-full", full);
  recycleBinIcon?.setAttribute(
    "aria-label",
    `Open Recycle Bin (${full ? `${recycleBin.length} deleted chat${recycleBin.length === 1 ? "" : "s"}` : "empty"})`
  );
  if (recycleBinEmptyBtn) recycleBinEmptyBtn.disabled = !full;
  if (recycleBinEmptyNote) recycleBinEmptyNote.hidden = full;
  if (recycleBinCount) {
    recycleBinCount.textContent = `${recycleBin.length} object${recycleBin.length === 1 ? "" : "s"}`;
  }
  if (!recycleBinList) return;
  recycleBinList.innerHTML = "";
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  for (const entry of recycleBin) {
    const row = document.createElement("li");
    row.className = "recycle-item";
    const info = document.createElement("div");
    info.className = "recycle-info";
    const title = document.createElement("span");
    title.className = "recycle-title";
    title.textContent = entry.title;
    title.title = entry.title;
    const date = document.createElement("span");
    date.className = "recycle-date";
    date.textContent = `Deleted ${when.format(entry.deletedAt)}`;
    info.append(title, date);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "about-ok recycle-btn";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore "${entry.title}"`);
    restore.addEventListener("click", () => restoreChat(entry.id));
    const purge = document.createElement("button");
    purge.type = "button";
    purge.className = "about-ok recycle-btn";
    purge.textContent = "Delete";
    purge.setAttribute("aria-label", `Permanently delete "${entry.title}"`);
    purge.addEventListener("click", () => purgeChat(entry.id));

    row.append(info, restore, purge);
    recycleBinList.appendChild(row);
  }
}

if (recycleBinIcon && recycleBinDialog) {
  recycleBinIcon.addEventListener("dblclick", () => {
    renderRecycleBin();
    if (!recycleBinDialog.open) recycleBinDialog.showModal();
  });
  recycleBinEmptyBtn?.addEventListener("click", emptyRecycleBin);
  recycleBinDialog
    .querySelectorAll("[data-close]")
    .forEach((close) => close.addEventListener("click", () => recycleBinDialog.close()));
}
renderRecycleBin();

document.addEventListener("pointerdown", (e) => {
  if (!contextMenu.hidden && !contextMenu.contains(e.target as Node)) closeContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !contextMenu.hidden) closeContextMenu();
});
contextMenu.addEventListener("focusout", (e) => {
  if (!contextMenu.contains(e.relatedTarget as Node | null)) closeContextMenu();
});
addEventListener("blur", closeContextMenu);
addEventListener("resize", closeContextMenu);
document.addEventListener("scroll", closeContextMenu, true);

function startRecentRename(target: SavedChat): void {
  if (recentRename) return;
  const field = document.createElement("input");
  field.className = "recent-item recent-rename";
  field.value = target.title;
  field.maxLength = MAX_TITLE_LENGTH;
  field.setAttribute("aria-label", "Chat name");
  recentRename = { target, field };

  const finish = (save: boolean) => {
    if (recentRename?.field !== field) return;
    recentRename = null;
    if (save) renameChat(target, field.value);
    renderRecents(); // puts the chat's button back
  };
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // Escape here shouldn't also close anything else
    finish(e.key === "Enter");
    input.focus();
  });
  field.addEventListener("blur", () => {
    if (!redrawingRecents) finish(true);
  });

  renderRecents();
  field.focus();
  field.select();
}

chatTitle.tabIndex = 0;
chatTitle.title = "Rename chat";
chatTitle.addEventListener("click", startRename);
chatTitle.addEventListener("blur", () => finishRename(true));
chatTitle.addEventListener("keydown", (e) => {
  if (!renaming) {
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startRename();
    }
    return;
  }
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    finishRename(e.key === "Enter");
    input.focus();
  }
});

function resizeInput(): void {
  input.style.height = "auto";
  if (input.value) input.style.height = input.scrollHeight + "px";
}

// ---- Image attachments ----
// Shrunk and re-encoded as JPEG in the browser before anything is sent.

function toJpeg(img: HTMLImageElement, maxSize: number, quality: number): string {
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  // JPEG has no transparency -- without this a transparent PNG turns black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function readAttachment(file: File): Promise<Attachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // rejects for formats the browser can't open (e.g. HEIC)
    return {
      base64: toJpeg(img, MODEL_IMAGE_SIZE, 0.9).split(",")[1],
      thumbnail: toJpeg(img, THUMBNAIL_SIZE, 0.75),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function setAttachment(next: Attachment | null): void {
  attachment = next;
  attachmentPreview.innerHTML = "";
  attachmentPreview.hidden = !next;
  if (!next) return;

  const thumb = document.createElement("img");
  thumb.src = next.thumbnail;
  thumb.alt = "Attached image";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "attachment-remove";
  remove.textContent = "×";
  remove.title = "Remove image";
  remove.setAttribute("aria-label", "Remove image");
  remove.addEventListener("click", () => {
    setAttachment(null);
    input.focus();
  });
  attachmentPreview.append(thumb, remove);
}

// A line of text where the attached image would go: a problem, or "busy"
// while a picked image is still being shrunk.
function showAttachmentNote(message: string, kind: "error" | "busy" = "error"): void {
  setAttachment(null);
  const note = document.createElement("span");
  note.className = `attachment-${kind}`;
  note.textContent = message;
  attachmentPreview.appendChild(note);
  attachmentPreview.hidden = false;
}

// Picking a second image while the first is still being prepared: only the
// latest one lands.
let attachSeq = 0;

async function attachFile(file: File): Promise<void> {
  const problem = uploadProblem(file);
  if (problem) return showAttachmentNote(problem);
  const seq = ++attachSeq;
  showAttachmentNote("Preparing image…", "busy");
  try {
    const prepared = await readAttachment(file);
    if (seq === attachSeq) setAttachment(prepared);
  } catch {
    if (seq === attachSeq) showAttachmentNote("Couldn't open that image -- try a JPEG, PNG, WebP or GIF.");
  }
  input.focus();
}

// ---- Profile picture ----
// Only for themes with a #profilePic button (the modern one -- the retro
// theme has its own buddy icons). Clicking it opens a small menu to upload
// or remove a picture, which is cropped to a square and kept in this
// browser only.

const PROFILE_PIC_KEY = "celta-chat.profilePicture";
// Crisp up to 3x the 32px it's shown at, and only ~20KB saved.
const PROFILE_PIC_SIZE = 96;

const profilePic = document.getElementById("profilePic") as HTMLButtonElement | null;
const profileFile = document.getElementById("profileFile") as HTMLInputElement | null;

async function readProfilePicture(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Center-crop to a square.
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PROFILE_PIC_SIZE;
    canvas
      .getContext("2d")!
      .drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        PROFILE_PIC_SIZE,
        PROFILE_PIC_SIZE
      );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

if (profilePic && profileFile) {
  const initial = profilePic.textContent ?? "";

  const menu = document.createElement("div");
  menu.className = "context-menu profile-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const uploadItem = document.createElement("button");
  uploadItem.type = "button";
  uploadItem.setAttribute("role", "menuitem");
  uploadItem.textContent = "Upload picture…";
  const removeItem = document.createElement("button");
  removeItem.type = "button";
  removeItem.setAttribute("role", "menuitem");
  removeItem.textContent = "Remove picture";
  const note = document.createElement("p");
  note.className = "menu-note";
  note.hidden = true;
  menu.append(uploadItem, removeItem, note);
  document.body.appendChild(menu);

  const loadPicture = (): string | null => {
    try {
      return localStorage.getItem(PROFILE_PIC_KEY);
    } catch {
      return null;
    }
  };

  const showPicture = (dataUrl: string | null) => {
    if (!dataUrl) {
      profilePic.replaceChildren(initial);
      profilePic.classList.remove("has-picture");
      return;
    }
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = "";
    profilePic.replaceChildren(img);
    profilePic.classList.add("has-picture");
  };

  const openMenu = (message = "") => {
    note.textContent = message;
    note.hidden = !message;
    removeItem.hidden = !profilePic.classList.contains("has-picture");
    menu.hidden = false;
    profilePic.setAttribute("aria-expanded", "true");
    // Opens upward: the button sits at the very bottom of the sidebar.
    const button = profilePic.getBoundingClientRect();
    menu.style.left = `${button.left}px`;
    menu.style.top = `${Math.max(4, button.top - menu.offsetHeight - 6)}px`;
    uploadItem.focus();
  };

  const closeMenu = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    profilePic.setAttribute("aria-expanded", "false");
  };

  profilePic.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  uploadItem.addEventListener("click", () => {
    closeMenu();
    profileFile.click();
  });
  removeItem.addEventListener("click", () => {
    closeMenu();
    try {
      localStorage.removeItem(PROFILE_PIC_KEY);
    } catch {
      // Storage blocked -- nothing was saved to remove.
    }
    showPicture(null);
    profilePic.focus();
  });

  profileFile.addEventListener("change", async () => {
    const file = profileFile.files?.[0];
    profileFile.value = ""; // so picking the same file again still fires "change"
    if (!file) return;
    const problem = uploadProblem(file);
    if (problem) return openMenu(problem);
    let dataUrl: string;
    try {
      dataUrl = await readProfilePicture(file);
    } catch {
      return openMenu("Couldn't open that image -- try a JPEG, PNG, WebP or GIF.");
    }
    showPicture(dataUrl);
    try {
      localStorage.setItem(PROFILE_PIC_KEY, dataUrl);
    } catch {
      openMenu("Set for now, but your browser wouldn't save it for next time.");
    }
  });

  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node;
    if (!menu.contains(target) && !profilePic.contains(target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      closeMenu();
      profilePic.focus();
    }
  });
  menu.addEventListener("focusout", (e) => {
    const next = e.relatedTarget as Node | null;
    if (!menu.contains(next) && next !== profilePic) closeMenu();
  });
  addEventListener("resize", closeMenu);

  showPicture(loadPicture());
}

function openChat(target: SavedChat): void {
  if (target !== activeChat) {
    if (input.value) drafts.set(activeChat.id, input.value);
    else drafts.delete(activeChat.id);
    if (attachment) draftAttachments.set(activeChat.id, attachment);
    else draftAttachments.delete(activeChat.id);
    input.value = drafts.get(target.id) ?? "";
    setAttachment(draftAttachments.get(target.id) ?? null);
    resizeInput();
  }
  activeChat = target;
  renderChat(target);
  renderRecents();
  input.focus();
}

function showTyping(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg bot typing";
  wrap.innerHTML = `<div class="avatar">AI</div><div class="bubble"><span></span><span></span><span></span><small class="typing-status"></small></div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

function setTypingStatus(typing: HTMLElement, status: string): void {
  typing.querySelector(".typing-status")!.textContent = status;
}

async function getReply(
  question: string,
  image: string | null,
  history: ChatMessage[],
  priorUrls: Set<string>,
  onStatus: (status: string) => void
): Promise<AgentResult> {
  if (CONFIG.useMock) {
    await new Promise<void>((r) => setTimeout(r, 900));
    return {
      answer: "This is a demo reply. Once the design is final, I'll be connected to your Gemma 3 model.",
      seenUrls: priorUrls,
      chartUrl: null,
      imageUrl: null,
    };
  }

  return runAgent(question, image, toLlmHistory(history), priorUrls, onStatus);
}

// Earlier images aren't sent again (that's a re-encode on every message) --
// just a note that one was there, next to the reply that described it.
function toLlmHistory(messages: ChatMessage[]): LlmMessage[] {
  return messages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message.role,
    content: message.image
      ? ["[The user attached an image to this message.]", message.content].filter(Boolean).join("\n")
      : message.content,
  }));
}

function describeError(error: Error): string {
  if (!error.message.includes("Failed to fetch")) return error.message;
  if (location.protocol === "file:") {
    return 'This page was opened as a file, so it can\'t reach the tools or Ollama. Run "npm start" and open http://localhost:8765 instead.';
  }
  // Setup hints are for whoever runs it; visitors to the public site just
  // need to know to try again.
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(CONFIG.bridgeUrl).hostname)) {
    return `Couldn't reach ${CONFIG.botName} -- check your internet connection and try again.`;
  }
  return `Could not reach the chat bridge at ${CONFIG.bridgeUrl}. Run "npm start" in the celta-chat folder and keep that terminal open.`;
}

async function send(raw: string): Promise<void> {
  const text = raw.trim();
  const image = attachment;
  if ((!text && !image) || busy) return;
  busy = true;

  // The reply belongs to this chat even if the user switches away while it loads.
  const target = activeChat;
  const priorMessages = target.messages.slice();
  const userMessage: ChatMessage = { role: "user", content: text };
  if (image) userMessage.image = image.thumbnail;
  if (!target.messages.length && !target.renamed) target.title = makeTitle(text) || "Image";
  target.messages.push(userMessage);
  touch(target);

  updateSuggestions();
  workspace.classList.remove("is-empty");
  chatTitle.textContent = target.title;
  addMessage("user", userMessage);
  input.value = "";
  drafts.delete(target.id);
  setAttachment(null);
  draftAttachments.delete(target.id);
  resizeInput();
  sendBtn.disabled = true;
  // Switching themes loads another page, which would drop this reply.
  if (themePicker) themePicker.disabled = true;

  const typing = showTyping();
  setBotStatus("Thinking…");
  pending = { chat: target, typing };
  const startedAt = performance.now();
  try {
    const result = await getReply(
      text,
      image?.base64 ?? null,
      priorMessages,
      new Set(target.seenUrls),
      (status) => {
        setTypingStatus(typing, status);
        setBotStatus(status);
      }
    );
    const reply: ChatMessage = {
      role: "assistant",
      content: result.answer,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (result.chartUrl) reply.chartUrl = result.chartUrl;
    if (result.imageUrl) reply.imageUrl = result.imageUrl;
    target.messages.push(reply);
    target.seenUrls = [...result.seenUrls];
    touch(target);
    typing.remove();
    if (activeChat === target) addMessage("bot", reply);
    // Exactly the history the next question in this chat will send.
    if (!CONFIG.useMock) void primeCache(toLlmHistory(target.messages));
  } catch (err) {
    typing.remove();
    // Errors are shown but not saved into the chat.
    if (activeChat === target) {
      addMessage("bot", {
        role: "assistant",
        content: `Sorry, something went wrong: ${describeError(err as Error)}`,
      });
    }
  } finally {
    setBotStatus("Online");
    pending = null;
    busy = false;
    sendBtn.disabled = false;
    if (themePicker) themePicker.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void send(input.value);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send(input.value);
  }
});

input.addEventListener("input", resizeInput);

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = ""; // so picking the same file again still fires "change"
  if (file) void attachFile(file);
});

// A pasted screenshot or copied image attaches too.
input.addEventListener("paste", (e) => {
  const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  void attachFile(file);
});

// So does one dropped anywhere on the chat, instead of the browser opening it.
workspace.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
workspace.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  void attachFile(file);
});

suggestions.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) =>
  c.addEventListener("click", () => void send(c.textContent ?? ""))
);

// The blank chat "New chat" opens. Reused until something is sent in it, so
// clicking away and back keeps its draft instead of starting another one.
let blankChat: SavedChat | null = chats.includes(activeChat) ? null : activeChat;

function openBlankChat(): void {
  if (!blankChat || chats.includes(blankChat)) blankChat = newChat();
  openChat(blankChat);
}

newChatBtn.addEventListener("click", openBlankChat);

// ---- Sidebar collapse ----
const SIDEBAR_KEY = "celta-chat.sidebarCollapsed";
const app = document.querySelector<HTMLElement>(".app")!;
const sidebarToggle = $<HTMLButtonElement>("sidebarToggle");

function setSidebarCollapsed(collapsed: boolean): void {
  app.classList.toggle("sidebar-collapsed", collapsed);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage blocked -- the choice just won't be remembered.
  }
}

sidebarToggle.addEventListener("click", () =>
  setSidebarCollapsed(!app.classList.contains("sidebar-collapsed"))
);

try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
} catch {
  setSidebarCollapsed(false);
}
// Enable the slide animation only after the saved state is in place.
requestAnimationFrame(() => requestAnimationFrame(() => app.classList.add("sidebar-ready")));

// ---- Model line and About ----
// Both are optional per theme: a #modelInfo line and an #aboutBtn that opens
// the About window. Its text is written once here so every theme says the
// same thing -- keep the privacy part to what's actually true of this setup.

const ABOUT_TOOL_LABELS: Record<string, string> = {
  web_search: "Search the web",
  image_search: "Find images",
  fetch_page: "Read a web page in full",
  wikipedia_summary: "Look things up on Wikipedia",
  calculate: "Do math",
  compare_stock_performance: "Compare stock and index performance, with a chart",
  stock_price_history: "Chart a stock's price history",
  plot_data: "Draw charts from numbers it found",
};

const modelInfo = document.getElementById("modelInfo");
const aboutBtn = document.getElementById("aboutBtn");
let aboutDialog: HTMLDialogElement | null = null;

if (modelInfo) {
  // Two parts, so a theme can set them on one line or stack them.
  const label = document.createElement("span");
  label.className = "model-label";
  label.textContent = "Model";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = CONFIG.modelLabel;
  modelInfo.replaceChildren(label, name);
  modelInfo.title = `${CONFIG.modelLabel} (${CONFIG.model}), running on a private server`;
}

function buildAboutDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "about-dialog";
  dialog.setAttribute("aria-labelledby", "aboutTitle");
  dialog.innerHTML = `
    <div class="about-titlebar">
      <h2 id="aboutTitle"></h2>
      <button type="button" class="about-close" aria-label="Close">×</button>
    </div>
    <div class="about-body">
      <p class="about-lead"></p>

      <h3>The model</h3>
      <ul class="about-model"></ul>

      <h3>What it can do</h3>
      <ul class="about-tools"><li>Checking…</li></ul>

      <h3>Your privacy</h3>
      <ul>
        <li><strong>No accounts, no ads, no tracking.</strong> Nothing you send is sold, shared for
          advertising, or used to train anything.</li>
        <li><strong>Your chats are saved only in this browser,</strong> on your own device -- never on a
          server. Clearing this site's data in your browser deletes them for good. So do the
          few things it remembers about you.</li>
        <li><strong>The AI model runs on a private server, not in a big company's cloud.</strong>
          It answers each message and doesn't keep a copy of it. The model was made by Google,
          but it runs on our hardware, so Google never sees your chats.</li>
        <li><strong>Images you attach</strong> go only to that same server, to be looked at by the model.</li>
      </ul>

      <h3>What does leave the server</h3>
      <ul>
        <li><strong>Web searches.</strong> To answer with current facts, your question is sent as a
          search query through a private search server (SearXNG), which passes it on to search
          engines such as Google, Brave and Wikipedia. They see the words searched for, but not
          who asked: no name, no account, no cookies, and the request comes from the search
          server rather than your device. If that server is down, the search goes straight to
          Brave from this computer instead.</li>
        <li><strong>Reading a page, Wikipedia lookups and stock prices</strong> (from Yahoo Finance)
          are fetched from this computer, like visiting those sites yourself -- they see your
          internet connection, but no account or cookies.</li>
        <li><strong>Links and pictures</strong> in answers load from the websites they come from, like
          any link you'd open yourself.</li>
      </ul>
      <p class="about-note">So: don't put anything in a question you wouldn't type into a search engine.</p>
    </div>
    <div class="about-actions"><button type="button" class="about-ok">OK</button></div>`;

  dialog.querySelector("#aboutTitle")!.textContent = `About ${CONFIG.botName}`;
  dialog.querySelector(".about-lead")!.textContent =
    `${CONFIG.botName} is a chat assistant that runs on a private server instead of a big ` +
    "AI company's cloud. It looks things up on the web as it answers, so it can talk about " +
    "current events, and it can read images you attach.";

  const facts: [string, string][] = [
    ["Model", `${CONFIG.modelLabel}, an open model by Google DeepMind (12 billion parameters)`],
    ["Runs on", "A private server with two graphics cards, using Ollama"],
    ["Model ID", CONFIG.model],
    ["Memory", `${CONFIG.numCtx.toLocaleString()} tokens -- roughly the last ${MAX_HISTORY_MESSAGES} messages of a chat`],
    ["Reads images", "Yes -- attach one with the + in the message box"],
    ["Knowledge", "Its built-in knowledge stops at its training data, so it searches for anything current"],
  ];
  const modelList = dialog.querySelector(".about-model")!;
  for (const [label, value] of facts) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = `${label}: `;
    item.append(name, value);
    modelList.appendChild(item);
  }

  // A theme's own credits (say, for its artwork) go at the end, from a
  // <template id="aboutCredits"> in its page.
  const credits = document.getElementById("aboutCredits") as HTMLTemplateElement | null;
  if (credits) dialog.querySelector(".about-body")!.append(credits.content.cloneNode(true));

  const close = () => dialog.close();
  dialog.querySelector(".about-close")!.addEventListener("click", close);
  dialog.querySelector(".about-ok")!.addEventListener("click", close);
  // A click on the dimmed backdrop lands on the dialog element itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

// The tools come from the bridge, so the list is whatever the bot really has.
async function fillAboutTools(dialog: HTMLDialogElement): Promise<void> {
  const list = dialog.querySelector(".about-tools")!;
  const lines = ["Remember things you tell it about yourself (saved in this browser)"];
  try {
    const tools = await loadTools();
    const labels = tools.map((tool) => ABOUT_TOOL_LABELS[tool.name] ?? tool.description);
    lines.unshift(...new Set(labels));
  } catch {
    lines.unshift("(Its web tools are offline right now -- start the bridge to use them.)");
  }
  list.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    })
  );
}

aboutBtn?.addEventListener("click", () => {
  aboutDialog ??= buildAboutDialog();
  aboutDialog.showModal();
  void fillAboutTools(aboutDialog);
});

// ---- Themes ----
// Each theme is its own page running this same script, so they share every
// saved chat. To add one: build its page with the same element ids, set
// data-theme-id on its <html>, add a <select id="themePicker"> somewhere,
// and list it here. The first theme is the default, served at the root.
interface Theme {
  id: string;
  name: string;
  // The page's folder, relative to the project root ("" for the root).
  path: string;
}

const THEMES: Theme[] = [
  { id: "modern", name: "Modern", path: "" },
  { id: "retro", name: "Retro IM", path: "retro/" },
];

// Read by the inline script at the top of index.html, which opens the
// remembered theme before the default page draws.
const THEME_KEY = "celta-chat.themePath";
// The chat that was open when the theme changed, reopened by the new page.
// Per tab, so a fresh visit still starts on a new chat.
const RESUME_KEY = "celta-chat.resumeChat";
// The project root: this script is always <root>/dist/main.js.
const appRoot = new URL("..", (document.currentScript as HTMLScriptElement).src);
const themePicker = document.getElementById("themePicker") as HTMLSelectElement | null;

if (themePicker) {
  const current = document.documentElement.dataset.themeId;
  for (const theme of THEMES) {
    themePicker.add(new Option(theme.name, theme.id, false, theme.id === current));
  }
  themePicker.addEventListener("change", () => {
    const theme = THEMES.find((t) => t.id === themePicker.value);
    if (!theme) return;
    try {
      if (theme === THEMES[0]) localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme.path);
      if (chats.includes(activeChat)) sessionStorage.setItem(RESUME_KEY, activeChat.id);
    } catch {
      // Storage blocked -- the switch still happens, it just isn't remembered.
    }
    location.href = new URL(theme.path, appRoot).href;
  });
}

function takeResumedChat(): SavedChat | null {
  try {
    const id = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return chats.find((c) => c.id === id) ?? null;
  } catch {
    return null;
  }
}

openChat(takeResumedChat() ?? activeChat);
