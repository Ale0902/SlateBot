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

interface Config {
  useMock: boolean;
  bridgeUrl: string;
  model: string;
  numCtx: number;
  numGpu: number | null;
  botName: string;
}

// ---- Config ----
// The page talks to server/bridge.py (npm start), which runs the MCP tool
// server and forwards chat requests to Ollama -- whether the page itself is
// served by the bridge or by something else like Live Server. The Ollama URL
// lives there (OLLAMA_URL, default http://10.7.163.103:11434).
const CONFIG: Config = {
  useMock: false,
  bridgeUrl: "http://127.0.0.1:8765",
  // gemma3:12b plus "PARAMETER num_gpu 49", created on the VM. Left to itself
  // Ollama only uses the GTX 1660 and runs half the model on the CPU; all 49
  // layers fit across both cards and write replies ~3x faster. The Discord
  // bot uses this same model, so the two never force a reload on each other.
  model: "gemma3-12b-gpu",
  numCtx: 8192,
  // Per-request layer override -- null leaves it to the model's own setting.
  // Sending a value that differs from what's loaded makes Ollama reload (~7s).
  numGpu: null,
  botName: "Chud Bot",
};

// Earlier question/answer pairs sent back to the model, oldest dropped first.
const MAX_HISTORY_MESSAGES = 16;

// Chats are saved in this browser only. Oldest drop off past the cap.
const CHATS_KEY = "celta-chat.chats";
const MAX_SAVED_CHATS = 50;
const MAX_TITLE_LENGTH = 60;
const GREETING = "Hi! How can I help you today?";
// gemma3 scales every image to 896x896 before looking at it, so anything
// bigger is only a slower upload and encode for no extra detail.
const MODEL_IMAGE_SIZE = 896;
// Sharp enough in the chat, small enough that a few saved images don't eat
// the ~5MB localStorage has for every chat.
const THUMBNAIL_SIZE = 480;

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
const newChatBtn = $<HTMLButtonElement>("newChatBtn");
const workspace = $<HTMLDivElement>("workspace");
const attachBtn = $<HTMLButtonElement>("attachBtn");
const fileInput = $<HTMLInputElement>("fileInput");
const attachmentPreview = $<HTMLDivElement>("attachmentPreview");

function loadChats(): SavedChat[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is SavedChat =>
          typeof c?.id === "string" && typeof c.title === "string" && Array.isArray(c.messages)
      )
      .map((c) => ({ ...c, seenUrls: Array.isArray(c.seenUrls) ? c.seenUrls : [], updatedAt: Number(c.updatedAt) || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function saveChats(): void {
  chats = chats.slice(0, MAX_SAVED_CHATS);
  // If storage is full, drop the oldest chats until it fits.
  while (chats.length) {
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
      return;
    } catch {
      if (chats.length === 1) return; // storage blocked entirely -- chats just won't persist
      chats = chats.slice(0, -1);
    }
  }
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
  const sourceUrl = match && /^https?:\/\//i.test(match[1]) ? match[1] : null;
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
    if (!preview || !card.isConnected) return card.remove();
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;

    if (preview.image) {
      const thumb = document.createElement("img");
      thumb.className = "link-card-thumb";
      thumb.src = preview.image;
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.referrerPolicy = "no-referrer";
      // Many sites refuse hotlinked images -- fall back to a text-only card.
      thumb.addEventListener("error", () => {
        thumb.remove();
        if (!preview.title) card.remove();
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
    card.hidden = false;
    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  });
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
document.body.appendChild(contextMenu);

let menuChat: SavedChat | null = null;
// The chat being renamed in Recents, and its text box -- kept so a redraw
// of the list (say, a reply arriving) doesn't throw away the edit.
let recentRename: { target: SavedChat; field: HTMLInputElement } | null = null;

function openContextMenu(target: SavedChat, x: number, y: number): void {
  menuChat = target;
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

function showAttachmentError(message: string): void {
  setAttachment(null);
  const note = document.createElement("span");
  note.className = "attachment-error";
  note.textContent = message;
  attachmentPreview.appendChild(note);
  attachmentPreview.hidden = false;
}

async function attachFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    showAttachmentError("Only images can be attached.");
    return;
  }
  try {
    setAttachment(await readAttachment(file));
  } catch {
    showAttachmentError("Couldn't open that image -- try a JPEG, PNG, WebP or GIF.");
  }
  input.focus();
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
  pending = { chat: target, typing };
  const startedAt = performance.now();
  try {
    const result = await getReply(
      text,
      image?.base64 ?? null,
      priorMessages,
      new Set(target.seenUrls),
      (status) => setTypingStatus(typing, status)
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

newChatBtn.addEventListener("click", () => {
  if (!blankChat || chats.includes(blankChat)) blankChat = newChat();
  openChat(blankChat);
});

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
