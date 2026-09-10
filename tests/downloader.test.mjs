// The half of this extension that has no browser in it — retrying, backing off, pacing,
// stopping, and walking the two paged endpoints — is tested here against a stubbed LINE.
//
// The content script is loaded into a vm context with chrome, fetch, JSZip, location and
// document supplied, which is exactly the set of globals it reaches for. Run it with
// `node --test tests/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts", "downloader.js"), "utf8");

// A response that looks enough like fetch's to satisfy the worker.
function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
    blob: async () => ({ size: 1, type: "application/octet-stream" }),
  };
}

function zipStub() {
  const written = [];
  const folder = (path) => ({
    folder: (name) => folder(`${path}/${name}`),
    file: (name) => written.push(`${path}/${name}`),
  });
  return {
    written,
    jszip: class {
      folder(name) {
        return folder(name);
      }
      async generateAsync() {
        return { size: 1 };
      }
    },
  };
}

// Loads the worker and returns its exposed surface plus the progress it broadcast.
function load({ fetchImpl, pathname = "/Ubot0001/chat/Uchat0001", bridgeImpl } = {}) {
  const zip = zipStub();
  const progress = [];
  const clicks = [];
  const bridged = [];

  // What scripts/background.js answers. The default is a one-byte file.
  const bridge =
    bridgeImpl ?? (async () => ({ ok: true, type: "image/png", base64: btoa("x") }));

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchImpl,
    atob,
    btoa,
    Blob,
    Uint8Array,
    JSON,
    TypeError,
    JSZip: zip.jszip,
    location: { pathname },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    document: { createElement: () => ({ click: () => clicks.push(true) }) },
    chrome: {
      runtime: {
        sendMessage: (message) => {
          if (message?.type === "archive:fetch") {
            bridged.push(message.url);
            return Promise.resolve(bridge(message.url));
          }
          progress.push(message.state);
          return Promise.resolve();
        },
        onMessage: { addListener: () => {} },
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const archive = sandbox.lineArchive;
  // Tests must not wait on real backoff.
  archive.tuning.retryBaseMs = 1;
  archive.tuning.retryCeilingMs = 4;
  archive.tuning.paceMs = 0;
  archive.tuning.emitMs = 0;
  return { archive, progress, zip, clicks, bridged };
}

const settle = async (archive, phases = ["done", "stopped", "failed"]) => {
  for (let i = 0; i < 2000; i += 1) {
    if (phases.includes(archive.state.phase)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`run never settled; phase is ${archive.state.phase}`);
};

test("a retryable status is retried, then the request succeeds", async () => {
  let calls = 0;
  const { archive } = load({
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? reply(503, null) : reply(200, { ok: true });
    },
  });

  const response = await archive.request("https://chat.line.biz/api/v2/anything");
  assert.equal(calls, 3);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(archive.state.retry, null, "the retry notice clears once a call succeeds");
});

test("a retryable status gives up after the attempt limit", async () => {
  let calls = 0;
  const { archive } = load({
    fetchImpl: async () => {
      calls += 1;
      return reply(500, null);
    },
  });

  await assert.rejects(() => archive.request("https://chat.line.biz/api/v2/anything"), {
    name: "HttpError",
    status: 500,
  });
  assert.equal(calls, archive.tuning.retryLimit + 1, "one first try plus five retries");
});

test("a client error is not retried", async () => {
  let calls = 0;
  const { archive } = load({
    fetchImpl: async () => {
      calls += 1;
      return reply(404, null);
    },
  });

  await assert.rejects(() => archive.request("https://chat.line.biz/api/v2/missing"), {
    name: "HttpError",
    status: 404,
  });
  assert.equal(calls, 1);
});

test("a network error is retried, and the attempt is reported", async () => {
  let calls = 0;
  const { archive, progress } = load({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return reply(200, { ok: true });
    },
  });

  await archive.request("https://chat.line.biz/api/v2/anything");
  assert.equal(calls, 2);
  const reported = progress.find((state) => state.retry);
  assert.ok(reported, "the popup is told that a retry is waiting");
  assert.equal(reported.retry.status, null, "a network error has no status to report");
  assert.equal(reported.retry.limit, archive.tuning.retryLimit);
});

test("Retry-After in seconds decides the wait", async () => {
  let calls = 0;
  const { archive, progress } = load({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? reply(429, null, { "Retry-After": "2" }) : reply(200, {});
    },
  });

  await archive.request("https://chat.line.biz/api/v2/anything");
  const waits = progress.filter((state) => state.retry).map((state) => state.retry.waitMs);
  assert.ok(waits.includes(2000), `expected a 2000ms wait, saw ${waits.join(", ")}`);
});

test("both paged endpoints follow their cursors to the end", async () => {
  const seen = [];
  const { archive } = load({
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes("/chats?")) {
        return url.includes("next=page2")
          ? reply(200, { list: [{ chatId: "Uc3" }], next: null })
          : reply(200, { list: [{ chatId: "Uc1" }, { chatId: "Uc2" }], next: "page2" });
      }
      return url.includes("backward=older")
        ? reply(200, { list: [{ id: 3 }], backward: null })
        : reply(200, { list: [{ id: 1 }, { id: 2 }], backward: "older" });
    },
  });

  const chats = [];
  for await (const id of archive.walkChats("Ubot0001")) chats.push(id);
  assert.deepEqual(chats, ["Uc1", "Uc2", "Uc3"]);
  assert.equal(archive.state.chatsFound, 3);

  const events = [];
  for await (const event of archive.walkMessages("Ubot0001", "Uc1")) events.push(event.id);
  assert.deepEqual(events, [1, 2, 3]);
  assert.ok(
    seen.some((url) => url.includes("limit=100")),
    "messages are read a hundred at a time",
  );
});

test("a whole run packs one folder per chat and reports done", async () => {
  const { archive, progress, zip, clicks } = load({
    fetchImpl: async (url) => {
      if (url.includes("/chats?")) {
        return reply(200, { list: [{ chatId: "Uchat0001" }], next: null });
      }
      if (url.includes("/messages")) {
        return reply(200, {
          list: [
            {
              type: "message",
              timestamp: 1_700_000_000_000,
              source: { chatId: "Uchat0001" },
              message: { type: "text", text: "สวัสดีค่ะ" },
            },
            {
              type: "messageSent",
              timestamp: 1_700_000_060_000,
              source: { chatId: "Uchat0001" },
              message: { type: "image", contentHash: "abc123" },
            },
          ],
          backward: null,
        });
      }
      return reply(200, {});
    },
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  assert.equal(archive.state.phase, "done");
  assert.equal(archive.state.messages, 2, "both sides of the conversation are kept");
  assert.equal(archive.state.files, 1, "the image was downloaded");
  assert.equal(archive.state.chatsDone, 1);
  assert.deepEqual(zip.written, ["Uchat0001/media/abc123.jpg", "Uchat0001/data.json"]);
  assert.equal(clicks.length, 1, "the zip was handed to the browser once");
  assert.equal(progress.at(-1).phase, "done");
});

test("an empty date box means no bound rather than an empty archive", async () => {
  const { archive } = load({
    fetchImpl: async (url) => {
      if (url.includes("/chats?")) {
        return reply(200, { list: [{ chatId: "Uchat0001" }], next: null });
      }
      if (url.includes("/messages")) {
        return reply(200, {
          list: [
            {
              type: "message",
              timestamp: 1_700_000_000_000,
              source: { chatId: "Uchat0001" },
              message: { type: "text", text: "in range" },
            },
          ],
          backward: null,
        });
      }
      return reply(200, {});
    },
  });

  // NaN is what an empty date input produced in the original, and it silently filtered
  // everything out.
  archive.start({ minTime: NaN, maxTime: NaN });
  await settle(archive);

  assert.equal(archive.state.phase, "done");
  assert.equal(archive.state.messages, 1);
});

test("a flex message is fetched as JSON, never as an attachment", async () => {
  const asked = [];
  const { archive, zip } = load({
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.includes("/chats?")) {
        return reply(200, { list: [{ chatId: "Uchat0001" }], next: null });
      }
      if (url.includes("/messages")) {
        return reply(200, {
          list: [
            {
              type: "message",
              timestamp: 1_700_000_000_000,
              source: { chatId: "Uchat0001" },
              // A flex message carries an id and no contentHash. Grouping it with the
              // attachments built ".../bot/<botId>/undefined", and LINE answered 400.
              message: { type: "flex", id: "468789577898262530" },
            },
          ],
          backward: null,
        });
      }
      return reply(200, { contents: {} });
    },
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  assert.equal(archive.state.phase, "done");
  assert.ok(
    !asked.some((url) => url.includes("undefined")),
    `no request may contain "undefined": ${asked.join(" ")}`,
  );
  assert.ok(asked.some((url) => url.includes("flexJson")));
  assert.deepEqual(zip.written, [
    "Uchat0001/flex-messages/468789577898262530.json",
    "Uchat0001/data.json",
  ]);
});

test("an attachment with no content hash is kept as a message and not downloaded", async () => {
  const asked = [];
  const { archive, zip } = load({
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.includes("/chats?")) {
        return reply(200, { list: [{ chatId: "Uchat0001" }], next: null });
      }
      if (url.includes("/messages")) {
        return reply(200, {
          list: [
            {
              type: "message",
              timestamp: 1_700_000_000_000,
              source: { chatId: "Uchat0001" },
              message: { type: "image" }, // LINE no longer holds the file
            },
          ],
          backward: null,
        });
      }
      return reply(200, {});
    },
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  assert.equal(archive.state.phase, "done");
  assert.equal(archive.state.skipped, 1, "the popup is told one attachment was skipped");
  assert.equal(archive.state.files, 0);
  assert.equal(archive.state.messages, 1, "the message itself is still in the archive");
  assert.ok(!asked.some((url) => url.includes("chat-content")), "no download was attempted");
  assert.deepEqual(zip.written, ["Uchat0001/data.json"]);
});

// A conversation holding one sticker, used by the two tests below.
const stickerChat = async (url) => {
  if (url.includes("/chats?")) return reply(200, { list: [{ chatId: "Uchat0001" }], next: null });
  if (url.includes("/messages")) {
    return reply(200, {
      list: [
        {
          type: "message",
          timestamp: 1_700_000_000_000,
          source: { chatId: "Uchat0001" },
          message: { type: "sticker", stickerId: "52114110", stickerResourceType: "ANIMATION" },
        },
      ],
      backward: null,
    });
  }
  return reply(200, {});
};

test("a sticker is downloaded through the background worker, not from the page", async () => {
  const { archive, zip, bridged } = load({ fetchImpl: stickerChat });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  assert.equal(archive.state.phase, "done");
  assert.equal(archive.state.files, 1);
  assert.equal(archive.state.skipped, 0);
  // The sticker CDN sends no CORS headers, so the page may not read the body. Only the
  // service worker may, and this is what proves the request went there.
  assert.deepEqual(bridged, [
    "https://stickershop.line-scdn.net/stickershop/v1/sticker/52114110/ANDROID/sticker_animation.png",
  ]);
  assert.deepEqual(zip.written, [
    "Uchat0001/stickers/52114110-sticker_animation.png",
    "Uchat0001/data.json",
  ]);
});

test("an attachment that will not download is skipped, and the archive is still saved", async () => {
  const { archive, zip, clicks } = load({
    fetchImpl: stickerChat,
    bridgeImpl: async () => ({ ok: false, error: "TypeError: Failed to fetch" }),
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  assert.equal(archive.state.phase, "done", "one dead file must not take the archive with it");
  assert.equal(archive.state.skipped, 1);
  assert.equal(archive.state.files, 0);
  assert.equal(archive.state.messages, 1, "the message is kept");
  assert.deepEqual(zip.written, ["Uchat0001/data.json"]);
  assert.equal(clicks.length, 1, "the zip was still handed to the browser");
});

test("a signed-out session still ends the run rather than skipping a file", async () => {
  const { archive } = load({
    fetchImpl: stickerChat,
    bridgeImpl: async () => ({ ok: false, status: 401 }),
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive, ["failed"]);

  assert.match(archive.state.error, /signed you out/);
});

test("a status that is never retried says so, and names the path that failed", async () => {
  const { archive } = load({
    fetchImpl: async (url) =>
      url.includes("/chats?") ? reply(400, null) : reply(200, { list: [], backward: null }),
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive, ["failed"]);

  assert.match(archive.state.error, /answered 400 on the first try/);
  assert.match(archive.state.error, /\/api\/v2\/bots/);
});

test("stop ends the run quickly and says nothing was saved", async () => {
  const { archive, clicks } = load({
    fetchImpl: async (url) => {
      if (url.includes("/chats?")) {
        return reply(200, { list: [{ chatId: "Uchat0001" }], next: "forever" });
      }
      return reply(200, { list: [], backward: null });
    },
  });

  archive.start({ minTime: null, maxTime: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(archive.stop().ok, true);
  await settle(archive, ["stopped"]);

  assert.equal(archive.state.phase, "stopped");
  assert.match(archive.state.error, /Nothing was saved/);
  assert.equal(clicks.length, 0, "a stopped run writes no zip");
});

test("a page opened outside a conversation refuses to start", async () => {
  const { archive } = load({ fetchImpl: async () => reply(200, {}), pathname: "/" });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive, ["failed"]);

  assert.match(archive.state.error, /Open a conversation/);
});

test("a second start is refused while a run is going", async () => {
  const { archive } = load({
    fetchImpl: async (url) =>
      url.includes("/chats?")
        ? reply(200, { list: [{ chatId: "Uchat0001" }], next: "forever" })
        : reply(200, { list: [], backward: null }),
  });

  assert.equal(archive.start({ minTime: null, maxTime: null }).ok, true);
  assert.equal(archive.start({ minTime: null, maxTime: null }).ok, false);
  archive.stop();
  await settle(archive, ["stopped"]);
});

test("rows sent to the popup are capped, and the count says how many are missing", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ chatId: `Uchat${i}` }));
  const { archive } = load({
    fetchImpl: async (url) =>
      url.includes("/chats?")
        ? reply(200, { list: many, next: null })
        : reply(200, { list: [], backward: null }),
  });

  archive.start({ minTime: null, maxTime: null });
  await settle(archive);

  const shown = archive.snapshot();
  assert.equal(shown.rows.length, 60);
  assert.equal(shown.rowsTotal, 80);
  assert.equal(archive.state.chatsDone, 80, "every chat was still walked");
});
