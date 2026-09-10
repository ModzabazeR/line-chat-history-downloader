// LINE chat archive — the worker.
//
// This runs inside the LINE Official Account Manager page, so every request carries the
// operator's own session. It walks the chat list, walks each chat backwards through its
// history, downloads the attachments, and hands the browser one zip.
//
// Three things were added to the original: every request retries, the run reports its
// progress so the popup can draw it, and the run can be stopped. The shape of the output is
// unchanged.
(() => {
  const API = "https://chat.line.biz/api";
  const CONTENT = "https://chat-content.line.biz/bot";
  const STICKERS = "https://stickershop.line-scdn.net/stickershop/v1/sticker";

  // Retry policy. An export is a long read of somebody else's service, so it waits rather
  // than hammers: five attempts, doubling, and Retry-After wins when the server sends one.
  // paceMs is the gap between ordinary requests — it keeps a long run closer to the speed of
  // a person reading, which is the only rate limit anybody has published.
  const tuning = {
    retryLimit: 5,
    retryBaseMs: 600,
    retryCeilingMs: 20_000,
    paceMs: 120,
    emitMs: 100,
  };

  const CHAT_PAGE = 25; // the chats endpoint refuses more
  const MESSAGE_PAGE = 100;

  class Stopped extends Error {
    constructor() {
      super("stopped");
      this.name = "Stopped";
    }
  }

  class HttpError extends Error {
    constructor(status, url, attempts) {
      super(`HTTP ${status}`);
      this.name = "HttpError";
      this.status = status;
      this.url = url;
      // How many times it was actually tried. A 4xx is never retried, so a message that says
      // "after 5 tries" when there was one sends whoever reads it looking for a flaky network
      // instead of for the bad request they actually have.
      this.attempts = attempts;
    }
  }

  // ---------------------------------------------------------------- state

  // One object describes the whole run, and the popup draws exactly this. It lives here
  // rather than in the popup, which is what lets somebody close the popup, open it again, and
  // still see where the run got to.
  const state = newState();
  let controller = null;
  let stopping = false;
  let running = false;

  function newState() {
    return {
      phase: "idle", // idle · listing · fetching · packing · done · stopped · failed
      botId: null,
      chatsFound: 0,
      chatsDone: 0,
      messages: 0,
      files: 0,
      skipped: 0, // attachments with nothing to download; the message itself is still kept
      rows: [], // newest first: { chatId, messages, files, phase, attempt, limit }
      startedAt: null,
      finishedAt: null,
      error: null,
      retry: null, // { attempt, limit, waitMs, status }
    };
  }

  function reset(botId) {
    Object.assign(state, newState(), { botId, phase: "listing", startedAt: Date.now() });
  }

  function snapshot() {
    // Rows are capped for the popup's sake: a thousand-chat account would otherwise send a
    // thousand rows on every tick. The counts above them stay exact.
    return { ...state, rows: state.rows.slice(0, 60), rowsTotal: state.rows.length };
  }

  let emitTimer = null;
  let emitPending = false;

  // Progress is broadcast, never awaited. Nothing listens while the popup is shut, and that
  // is the normal case rather than an error — so the rejection is dropped here and the run
  // carries on.
  function emit({ now = false } = {}) {
    if (now) {
      clearTimeout(emitTimer);
      emitTimer = null;
      emitPending = false;
      send();
      return;
    }
    if (emitTimer) {
      emitPending = true;
      return;
    }
    send();
    emitTimer = setTimeout(() => {
      emitTimer = null;
      if (emitPending) {
        emitPending = false;
        emit();
      }
    }, tuning.emitMs);
  }

  function send() {
    try {
      const sent = chrome.runtime.sendMessage({ type: "archive:progress", state: snapshot() });
      if (sent && typeof sent.catch === "function") sent.catch(() => {});
    } catch {
      // The popup is closed. Expected.
    }
  }

  // ---------------------------------------------------------------- requests

  function retryable(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function backoffMs(attempt) {
    const grow = tuning.retryBaseMs * 2 ** (attempt - 1);
    const capped = Math.min(grow, tuning.retryCeilingMs);
    return capped + Math.random() * (capped / 4); // jitter, so two tabs do not sync up
  }

  // Retry-After is either seconds or an HTTP date. A server that says how long to wait knows
  // better than the backoff curve does.
  function retryAfterMs(response) {
    const header = response?.headers?.get?.("Retry-After");
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(header);
    return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
  }

  // Sleep in slices, so Stop is answered in a tenth of a second rather than after a
  // twenty-second backoff has run its course.
  //
  // It always waits on a timer at least once, even for a zero-length sleep, and that is not a
  // rounding detail. A loop that awaits nothing but already-resolved promises never gives the
  // timer queue a turn, so Stop — which arrives on a timer — can never land, and the run
  // becomes unstoppable. Pacing is therefore the run's only yield point, and it must yield.
  async function sleep(ms) {
    const until = Date.now() + ms;
    do {
      if (stopping) throw new Stopped();
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(100, until - Date.now()))));
    } while (Date.now() < until);
    if (stopping) throw new Stopped();
  }

  // Everything that is not chat.line.biz is fetched by the service worker instead of by this
  // page. See scripts/background.js: the sticker CDN sends no CORS headers, so a fetch from
  // here fails with "TypeError: Failed to fetch" however many times it is tried.
  function crossOrigin(url) {
    return !url.startsWith(API);
  }

  async function bridge(url) {
    const answer = await chrome.runtime.sendMessage({ type: "archive:fetch", url });
    if (!answer) throw new TypeError("the extension's background worker did not answer");
    if (!answer.ok) {
      if (answer.status) return { ok: false, status: answer.status, headers: { get: () => null } };
      throw new TypeError(answer.error ?? "the download failed");
    }
    // Rebuilt here rather than sent as a blob, because a message must be JSON.
    const raw = atob(answer.base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const body = new Blob([bytes], { type: answer.type });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? answer.type : null) },
      blob: async () => body,
      json: async () => JSON.parse(await body.text()),
    };
  }

  async function request(url, init = {}) {
    let attempt = 0;
    for (;;) {
      if (stopping) throw new Stopped();
      attempt += 1;
      try {
        const response = crossOrigin(url)
          ? await bridge(url)
          : await fetch(url, {
              credentials: "include",
              signal: controller?.signal,
              ...init,
            });
        if (response.ok) {
          if (state.retry) {
            state.retry = null;
            emit();
          }
          // Unconditional, even when paceMs is zero — see sleep().
          await sleep(tuning.paceMs);
          return response;
        }
        if (!retryable(response.status) || attempt > tuning.retryLimit) {
          throw new HttpError(response.status, url, attempt);
        }
        await hold(attempt, response);
      } catch (error) {
        if (error instanceof Stopped || error.name === "AbortError") throw new Stopped();
        if (error instanceof HttpError) throw error;
        // A network error: the tab went offline, or LINE dropped the connection.
        if (attempt > tuning.retryLimit) throw error;
        await hold(attempt, null);
      }
    }
  }

  async function hold(attempt, response) {
    const waitMs = retryAfterMs(response) ?? backoffMs(attempt);
    state.retry = {
      attempt,
      limit: tuning.retryLimit,
      waitMs: Math.round(waitMs),
      status: response?.status ?? null,
    };
    const row = state.rows[0];
    if (row && row.phase === "working") {
      row.phase = "retrying";
      row.attempt = attempt;
      row.limit = tuning.retryLimit;
    }
    emit({ now: true });
    await sleep(waitMs);
    if (row && row.phase === "retrying") row.phase = "working";
  }

  const json = async (url) => (await request(url)).json();
  const binary = async (url) => (await request(url)).blob();

  // The failing path, short enough to read in the popup. It is what tells somebody which of
  // the five endpoints refused them, which the status alone never does.
  function short(url) {
    try {
      const { pathname } = new URL(url);
      return pathname.length > 48 ? `…${pathname.slice(-47)}` : pathname;
    } catch {
      return url;
    }
  }

  // ---------------------------------------------------------------- walking

  async function* walkChats(botId) {
    let next = null;
    for (;;) {
      const page = await json(
        `${API}/v2/bots/${botId}/chats?folderType=ALL&tagIds=&autoTagIds=&limit=${CHAT_PAGE}` +
          `${next ? `&next=${encodeURIComponent(next)}` : ""}&prioritizePinnedChat=true`,
      );
      next = page.next;
      for (const chat of page.list ?? []) {
        state.chatsFound += 1;
        emit();
        yield chat.chatId;
      }
      if (!next) return;
    }
  }

  async function* walkMessages(botId, chatId) {
    let backward = null;
    for (;;) {
      const page = await json(
        `${API}/v3/bots/${botId}/chats/${chatId}/messages?limit=${MESSAGE_PAGE}` +
          `${backward ? `&backward=${encodeURIComponent(backward)}` : ""}`,
      );
      backward = page.backward;
      for (const event of page.list ?? []) yield event;
      if (!backward) return;
    }
  }

  // ---------------------------------------------------------------- shaping

  function extension(type) {
    switch (type) {
      case "image":
        return ".jpg";
      case "audio":
        return ".m4a";
      case "video":
        return ".mp4";
      default:
        return "";
    }
  }

  function record(chatId, timestamp, message, role) {
    switch (message.type) {
      case "text":
        if (message.originalType === "flex") {
          return { type: "flex", id: chatId, messageId: message.id, timestamp, role };
        }
        return { type: "text", id: chatId, timestamp, content: message.text, role };
      // A flex message is JSON and carries no content hash — it is fetched from the flexJson
      // endpoint by message id. The original grouped it with the attachments, which built a
      // download URL ending in "undefined" and made LINE answer 400.
      case "flex":
        return message.id
          ? { type: "flex", id: chatId, messageId: message.id, timestamp, role }
          : { type: "skipped", id: chatId, timestamp, role, why: "flex message with no id" };
      case "image":
      case "file":
      case "audio":
      case "video":
        // No hash means LINE is not holding the file any more, or never held it — one hosted
        // somewhere else, for instance. The message is kept and the download is not attempted,
        // because a URL built out of "undefined" is a request that cannot succeed.
        if (!message.contentHash) {
          return {
            type: "skipped",
            id: chatId,
            timestamp,
            role,
            why: `${message.type} with no content hash`,
          };
        }
        return {
          type: "media",
          id: chatId,
          timestamp,
          media: message.contentHash,
          fileName: `${message.contentHash}${extension(message.type)}`,
          role,
        };
      case "sticker":
        return {
          type: "sticker",
          id: chatId,
          timestamp,
          sticker: message.stickerId,
          stickerResourceType:
            message.stickerResourceType === "STATIC" || message.stickerResourceType === "POPUP"
              ? "sticker.png"
              : "sticker_animation.png",
          role,
        };
      default:
        return null;
    }
  }

  async function collect(botId, chatId, from, to) {
    const out = [];
    for await (const event of walkMessages(botId, chatId)) {
      if (stopping) throw new Stopped();
      const role = event.type === "messageSent" ? "bot" : event.type === "message" ? "user" : null;
      if (!role) continue;
      if (event.timestamp < from || event.timestamp > to) continue;
      const shaped = record(event.source.chatId, event.timestamp, event.message, role);
      if (!shaped) continue;
      out.push(shaped);
      if (shaped.type === "skipped") state.skipped += 1;
      state.messages += 1;
      if (state.rows[0]) state.rows[0].messages += 1;
      emit();
    }
    return out;
  }

  // ---------------------------------------------------------------- the run

  async function run({ minTime, maxTime }) {
    const botId = location.pathname.split("/").filter(Boolean)[0];
    if (!botId) {
      Object.assign(state, newState(), {
        phase: "failed",
        error: "Open a conversation in LINE Official Account Manager, then start again.",
      });
      emit({ now: true });
      return;
    }

    // An empty date box means no bound. The original read an empty box as NaN, every message
    // then failed the comparison, and the run finished with an empty zip and no explanation.
    const from = Number.isFinite(minTime) ? minTime : 0;
    const to = Number.isFinite(maxTime) ? maxTime : Number.MAX_SAFE_INTEGER;

    reset(botId);
    controller = new AbortController();
    const zip = new JSZip();
    let packed = 0;

    try {
      for await (const chatId of walkChats(botId)) {
        state.phase = "fetching";
        state.rows.unshift({ chatId, messages: 0, files: 0, phase: "working" });
        emit({ now: true });

        const data = await collect(botId, chatId, from, to);
        const row = state.rows[0];

        if (data.length === 0) {
          row.phase = "empty";
          state.chatsDone += 1;
          emit();
          continue;
        }

        const folder = zip.folder(data[0].id);
        const media = folder.folder("media");
        const stickers = folder.folder("stickers");
        const flex = folder.folder("flex-messages");

        // An attachment that will not come down is counted and passed over. It must not take
        // the archive with it: the message is already collected, the other nine hundred chats
        // are already read, and losing all of that over one file on a CDN is the wrong trade.
        // Stop and a signed-out session still end the run, because neither is one bad file.
        const attach = async (put) => {
          try {
            await put();
            state.files += 1;
            row.files += 1;
          } catch (error) {
            if (error instanceof Stopped) throw error;
            if (error instanceof HttpError && error.status === 401) throw error;
            state.skipped += 1;
          }
          emit();
        };

        for (const file of data.filter((i) => i.type === "media" && i.media)) {
          await attach(async () =>
            media.file(file.fileName, await binary(`${CONTENT}/${botId}/${file.media}`)),
          );
        }
        for (const sticker of data.filter((i) => i.type === "sticker")) {
          await attach(async () =>
            stickers.file(
              `${sticker.sticker}-${sticker.stickerResourceType}`,
              await binary(`${STICKERS}/${sticker.sticker}/ANDROID/${sticker.stickerResourceType}`),
            ),
          );
        }
        for (const item of data.filter((i) => i.type === "flex")) {
          await attach(async () => {
            const body = await json(
              `${API}/v1/bots/${botId}/messages/${chatId}/flexJson` +
                `?timestamp=${item.timestamp}&messageId=${item.messageId}`,
            );
            flex.file(`${item.messageId}.json`, JSON.stringify(body));
          });
        }

        folder.file(
          "data.json",
          JSON.stringify(
            data.map((item) => {
              const { id, media: _contentHash, ...rest } = item;
              return rest;
            }),
          ),
        );

        row.phase = "done";
        state.chatsDone += 1;
        packed += 1;
        emit();
      }

      if (packed === 0) {
        state.phase = "done";
        state.finishedAt = Date.now();
        state.error = "No messages fall inside those dates, so there was nothing to save.";
        emit({ now: true });
        return;
      }

      state.phase = "packing";
      emit({ now: true });
      save(await zip.generateAsync({ type: "blob" }));
      state.phase = "done";
      state.finishedAt = Date.now();
      emit({ now: true });
    } catch (error) {
      state.finishedAt = Date.now();
      if (error instanceof Stopped) {
        state.phase = "stopped";
        state.error = "Stopped. Nothing was saved — the zip is written at the end of the run.";
      } else if (error instanceof HttpError && error.status === 401) {
        state.phase = "failed";
        state.error = "LINE signed you out. Reload the page, sign in, and start again.";
      } else if (error instanceof HttpError) {
        state.phase = "failed";
        const tries = error.attempts === 1 ? "on the first try" : `after ${error.attempts} tries`;
        state.error =
          `LINE answered ${error.status} ${tries} for ${short(error.url)}. Nothing was saved.`;
      } else {
        state.phase = "failed";
        state.error = `${error.name}: ${error.message}. Nothing was saved.`;
      }
      emit({ now: true });
    } finally {
      running = false;
      stopping = false;
      controller = null;
      state.retry = null;
    }
  }

  function save(archive) {
    const url = URL.createObjectURL(archive);
    const a = document.createElement("a");
    a.href = url;
    a.download = `line-archive-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function start(message) {
    if (running) return { ok: false, reason: "already running" };
    running = true;
    stopping = false;
    run(message);
    return { ok: true };
  }

  function stop() {
    if (!running) return { ok: false, reason: "not running" };
    stopping = true;
    controller?.abort();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    switch (message?.type) {
      case "archive:state":
        reply({ state: snapshot() });
        return true;
      case "archive:start":
        reply(start(message));
        return true;
      case "archive:stop":
        reply(stop());
        return true;
      default:
        return false;
    }
  });

  // Exposed so the behaviour with no browser in it — retry, backoff, pacing, stopping — can
  // be driven by a test rather than by clicking and hoping. A content script runs in an
  // isolated world, so nothing on the page can reach this.
  globalThis.lineArchive = {
    state,
    snapshot,
    request,
    walkChats,
    walkMessages,
    start,
    stop,
    tuning,
    errors: { Stopped, HttpError },
  };
})();
