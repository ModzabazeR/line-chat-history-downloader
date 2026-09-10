// LINE chat archive — the download bridge.
//
// Attachments and stickers do not come from chat.line.biz. They come from
// chat-content.line.biz and stickershop.line-scdn.net, and a content script's cross-origin
// request obeys the page's CORS rules like any other. The sticker CDN sends no CORS headers
// at all — the Chats screen shows stickers with <img>, which is exempt — so a fetch from the
// page fails with "TypeError: Failed to fetch", and no amount of retrying changes it.
//
// A service worker is not bound by that. With host_permissions for the two hosts, its own
// fetch may read the body, so every cross-origin download is routed through here.
//
// The bytes come back as base64 because a message must be JSON. That costs a third more
// bytes in transit between two parts of the same extension, which is cheaper than the
// alternative of not having the file.

const ALLOWED = ["https://chat-content.line.biz/", "https://stickershop.line-scdn.net/"];

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // In chunks: String.fromCharCode with a whole video's worth of arguments overflows the
  // stack, and it does that only on the large files nobody tests with.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== "archive:fetch") return false;

  // The bridge fetches what the archive needs and nothing else. Without this, anything that
  // can reach the extension could ask it to fetch a URL with the user's cookies attached.
  if (!ALLOWED.some((prefix) => String(message.url).startsWith(prefix))) {
    reply({ ok: false, error: "that host is not one this extension downloads from" });
    return true;
  }

  fetch(message.url, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) {
        reply({ ok: false, status: response.status });
        return;
      }
      reply({
        ok: true,
        type: response.headers.get("Content-Type") ?? "application/octet-stream",
        base64: toBase64(await response.arrayBuffer()),
      });
    })
    .catch((error) => reply({ ok: false, error: `${error.name}: ${error.message}` }));

  return true; // the reply comes later
});
