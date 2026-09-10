// LINE chat archive — the popup.
//
// The popup owns no state. The run lives in the content script, so closing this window and
// opening it again shows the run where it actually is rather than an empty form. On open it
// asks the tab for a snapshot; after that it draws whatever the tab broadcasts.

const el = (id) => document.getElementById(id);

const ui = {
  subject: el("subject"),
  chip: el("chip"),
  setup: el("setup"),
  start: el("start"),
  end: el("end"),
  build: el("build"),
  run: el("run"),
  meter: el("meter"),
  fill: el("fill"),
  chats: el("count-chats"),
  messages: el("count-messages"),
  files: el("count-files"),
  time: el("count-time"),
  retry: el("retry"),
  ledger: el("ledger"),
  ledgerMore: el("ledger-more"),
  stop: el("stop"),
  note: el("note"),
};

const ACTIVE = new Set(["listing", "fetching", "packing"]);

const PHASE_WORDS = {
  idle: "Idle",
  listing: "Reading chats",
  fetching: "Archiving",
  packing: "Packing zip",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

const MARKS = {
  working: "reading",
  retrying: "retry",
  done: "sealed",
  empty: "no match",
};

let tabId = null;
let ticker = null;
let startedAt = null;

// ---------------------------------------------------------------- talking to the tab

async function ask(message) {
  if (tabId === null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script is not in this tab. That happens on a tab that was already open when
    // the extension was installed, and a reload is the whole fix — so say that, rather than
    // leaving a button that does nothing.
    offer(false, "Reload this LINE tab once, then open this window again.");
    return null;
  }
}

// ---------------------------------------------------------------- drawing

function offer(canRun, why) {
  ui.build.disabled = !canRun;
  if (why) note(why, "halt");
}

function note(text, tone) {
  ui.note.hidden = !text;
  ui.note.textContent = text ?? "";
  if (tone) ui.note.dataset.tone = tone;
  else delete ui.note.dataset.tone;
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function shortId(id) {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function render(state) {
  const active = ACTIVE.has(state.phase);

  ui.chip.dataset.phase = state.phase;
  ui.chip.textContent = PHASE_WORDS[state.phase] ?? state.phase;

  ui.setup.hidden = active;
  ui.run.hidden = state.phase === "idle";
  ui.stop.hidden = !active;

  if (state.botId) ui.subject.textContent = state.botId;

  // Until the chat list is fully read, chatsFound is still growing, so a share of it would
  // move backwards. The bar stays indeterminate through the listing phase for that reason.
  const known = state.phase !== "listing" && state.chatsFound > 0;
  ui.meter.dataset.indeterminate = String(active && !known);
  ui.fill.style.width = known ? `${Math.round((state.chatsDone / state.chatsFound) * 100)}%` : "";
  if (state.phase === "done") ui.meter.dataset.tone = "done";
  else if (state.phase === "stopped" || state.phase === "failed") ui.meter.dataset.tone = "halt";
  else delete ui.meter.dataset.tone;
  if (state.phase === "done") ui.fill.style.width = "100%";

  ui.chats.textContent = `${state.chatsDone} / ${state.chatsFound}`;
  ui.messages.textContent = state.messages.toLocaleString();
  ui.files.textContent = state.files.toLocaleString();

  startedAt = state.startedAt;
  const until = state.finishedAt ?? Date.now();
  ui.time.textContent = state.startedAt ? clock(until - state.startedAt) : "0:00";

  if (state.retry) {
    ui.retry.hidden = false;
    const because = state.retry.status
      ? `LINE answered ${state.retry.status}`
      : "the request failed";
    ui.retry.textContent =
      `${because} — try ${state.retry.attempt} of ${state.retry.limit}, ` +
      `waiting ${(state.retry.waitMs / 1000).toFixed(1)}s`;
  } else {
    ui.retry.hidden = true;
  }

  drawLedger(state);

  if (state.error) note(state.error, state.phase === "done" ? null : "halt");
  else if (state.phase === "done") note(`Saved ${state.chatsDone} chats to your downloads.`, "done");
  else note(null);

  if (active && !ticker) ticker = setInterval(tick, 1000);
  if (!active && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function drawLedger(state) {
  ui.ledger.replaceChildren(
    ...state.rows.map((row) => {
      const li = document.createElement("li");
      li.className = "row";
      li.dataset.phase = row.phase;

      const id = document.createElement("span");
      id.className = "id";
      id.textContent = shortId(row.chatId);

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = row.files
        ? `${row.messages} msg · ${row.files} files`
        : `${row.messages} msg`;

      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent =
        row.phase === "retrying"
          ? `${MARKS.retrying} ${row.attempt}/${row.limit}`
          : MARKS[row.phase];

      li.append(id, n, mark);
      return li;
    }),
  );

  const hidden = (state.rowsTotal ?? state.rows.length) - state.rows.length;
  ui.ledgerMore.hidden = hidden <= 0;
  ui.ledgerMore.textContent = hidden > 0 ? `${hidden} earlier chats not listed` : "";
}

// The elapsed time is the one number the tab does not need to send, because it changes on its
// own. Ticking it here keeps the broadcast quiet.
function tick() {
  if (startedAt) ui.time.textContent = clock(Date.now() - startedAt);
}

// ---------------------------------------------------------------- dates

// Local midnight, not UTC midnight. Somebody who types 31 January means their own 31 January,
// and the end date covers the whole of that day.
function bound(input, endOfDay) {
  if (!input.value) return null;
  const at = new Date(`${input.value}T00:00:00`);
  if (Number.isNaN(at.getTime())) return null;
  return endOfDay ? at.getTime() + 86_400_000 - 1 : at.getTime();
}

// ---------------------------------------------------------------- wiring

ui.build.addEventListener("click", async () => {
  const from = bound(ui.start, false);
  const to = bound(ui.end, true);
  if (from !== null && to !== null && from > to) {
    note("The From date falls after the To date.", "halt");
    return;
  }
  note(null);
  const reply = await ask({ type: "archive:start", minTime: from, maxTime: to });
  if (reply && reply.ok === false) note("A run is already going in this tab.", "halt");
});

ui.stop.addEventListener("click", async () => {
  ui.stop.disabled = true;
  await ask({ type: "archive:stop" });
  ui.stop.disabled = false;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "archive:progress") render(message.state);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https:\/\/chat\.line\.biz\/.+/.test(tab.url ?? "")) {
    ui.subject.textContent = "Not a LINE chat page";
    ui.setup.hidden = true;
    note("Open a conversation in LINE Official Account Manager, then try again.", "halt");
    return;
  }
  tabId = tab.id;
  ui.subject.textContent = new URL(tab.url).pathname.split("/").filter(Boolean)[0] ?? "";

  const reply = await ask({ type: "archive:state" });
  if (reply?.state) render(reply.state);
})();
