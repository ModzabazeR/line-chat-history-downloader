# LINE chat archive

A Chrome extension that exports the chat history of a LINE Official Account to a zip, from
inside LINE Official Account Manager. It uses the operator's own session, so it needs no API
key and no paid package.

A fork of [xiaoxigua-1/line-bot-chat-history-downloader](https://github.com/xiaoxigua-1/line-bot-chat-history-downloader),
which did the hard part: finding the endpoints the Chats screen uses. This fork adds progress,
retries and a Stop button.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
   the folder.
3. Open LINE Official Account Manager and go to a conversation, so the address looks like
   `https://chat.line.biz/<botId>/chat/<chatId>`. A tab that was already open when you
   installed the extension needs one reload.

## Use

Click the extension icon, set the dates you want, and click **Build archive**.

Leave a date box empty for no limit. Both dates count in full and in your own timezone, so
**To: 31 January** includes everything up to the end of that day.

While the run goes, the window shows the phase, a bar, the counts, and a ledger of every chat
it has finished. Closing the window does not stop the run — the work lives in the page — and
opening it again shows where the run got to. **Stop** ends the run.

## What you get

    line-archive-2026-09-10.zip
    └── <chatId>/
        ├── data.json          every message: type, timestamp, role (user or bot), text
        ├── media/             images, video, audio and files, named by content hash
        ├── stickers/          sticker images
        └── flex-messages/     the JSON behind each flex message

## Known limits

These are inherited and are not yet fixed:

- **The zip is written at the end.** A run that fails or is stopped saves nothing. One
  attachment that will not download is no longer such a failure: it is counted as skipped and
  the run carries on.
- **You get chat ids, not customer names.**
- **Only text, image, video, audio, file, sticker and flex are handled.** Other event types are
  skipped.
- **LINE keeps 6 months of chat history on the free plan.** Nothing here changes that — the
  extension reads what LINE still stores.
- `popup/font-awesome/` is left over from the original and nothing uses it.

## Tests

    node --test tests/downloader.test.mjs

The tests load the content script into a `vm` context with `chrome`, `fetch`, `JSZip`,
`location` and `document` stubbed, then drive the parts with no browser in them: retrying,
backoff, `Retry-After`, pacing, stopping, and the two paged endpoints.

## How it works

`scripts/downloader.js` runs in the page and does the work. `popup/` only draws what the page
reports, and sends three messages back: `archive:start`, `archive:stop` and `archive:state`. The
page broadcasts `archive:progress` as the run moves, which is why the popup can be closed and
opened again without losing anything.

`scripts/background.js` downloads the attachments. It has to: they come from
`chat-content.line.biz` and `stickershop.line-scdn.net`, and a content script's cross-origin
request obeys the page's CORS rules. The sticker CDN sends no CORS headers — the Chats screen
draws stickers with `<img>`, which is exempt — so a fetch from the page fails with
`TypeError: Failed to fetch` however many times it is tried. A service worker holding
`host_permissions` for those two hosts may read the body, and it passes the bytes back as
base64. It refuses any URL outside those two hosts.

## A word of care

The endpoints under `chat.line.biz/api` are undocumented. LINE can change them without notice,
and LINE's terms do not invite automated access. Keep runs slow, run one at a time, and
remember that the account at risk is the one whose history you are saving.

MIT, as the original.
