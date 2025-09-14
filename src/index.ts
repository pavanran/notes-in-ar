// index.ts (or src/index.ts)
import { AppServer, AppSession } from "@mentra/sdk";
import { promises as fs } from "fs";
import path from "path";

/** ========== CONFIG ========= */
const APP_PORT = Number(process.env.PORT ?? "3000");
const EXPORT_PORT = 3030; // tiny HTTP server for exports

console.log("API key loaded:", !!process.env.MENTRAOS_API_KEY ? "✔" : "✘");

/** ========== TYPES & STATE ========= */
type NoteItem = { text: string; ts: number; tags?: string[]; expiresAt?: number };
type Reminder = { id: string; text: string; dueTs: number; createdTs: number };

let notes: NoteItem[] = [];
let reminders: Reminder[] = [];
let reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const DATA_NOTES = path.join(process.cwd(), "notes.json");
const DATA_REMS  = path.join(process.cwd(), "reminders.json");

/** ========== PERSISTENCE ========= */
async function loadAll() {
  try {
    const raw = await fs.readFile(DATA_NOTES, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      notes = arr.filter(x => x && typeof x.text === "string" && typeof x.ts === "number").slice(0, 500);
    }
  } catch {}
  try {
    const raw = await fs.readFile(DATA_REMS, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      reminders = arr.filter(r => r && typeof r.text === "string" && typeof r.dueTs === "number").slice(0, 500);
    }
  } catch {}
  loaded = true;
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.writeFile(DATA_NOTES, JSON.stringify(notes, null, 2), "utf8");
      await fs.writeFile(DATA_REMS, JSON.stringify(reminders, null, 2), "utf8");
    } catch (e) { console.warn("Save failed:", e); }
  }, 250);
}

/** ========== NOTES HELPERS ========= */
function addNote(n: NoteItem) { notes.unshift(n); if (notes.length > 500) notes.pop(); scheduleSave(); }
function clearAllNotes() { notes.length = 0; scheduleSave(); }
function deleteNoteIndex(idx1: number) { const i = idx1 - 1; if (i<0||i>=notes.length) return null; const [r]=notes.splice(i,1); scheduleSave(); return r??null; }
function undoLastNote() { if (!notes.length) return null; const [r]=notes.splice(0,1); scheduleSave(); return r??null; }

/** ========== REMINDERS ========= */
function id() { return Math.random().toString(36).slice(2, 10); }
function scheduleReminder(session: AppSession, r: Reminder) {
  const ms = r.dueTs - Date.now();
  if (ms <= 0) return fireReminder(session, r);
  const t = setTimeout(() => fireReminder(session, r), ms);
  reminderTimers.set(r.id, t);
}
function fireReminder(session: AppSession, r: Reminder) {
  void session.layouts.showReferenceCard("Reminder", r.text, { durationMs: 6000 });
  void tryWriteDashboard(session, `🔔 ${formatTime(new Date())}  ${r.text}`);
  reminders = reminders.filter(x => x.id !== r.id);
  scheduleSave();
  const t = reminderTimers.get(r.id); if (t) { clearTimeout(t); reminderTimers.delete(r.id); }
}
function scheduleAllReminders(session: AppSession) {
  for (const [,t] of reminderTimers) clearTimeout(t); reminderTimers.clear();
  for (const r of reminders) scheduleReminder(session, r);
}

/** ========== PARSERS ========= */
// --- number words -> number (one..twenty + thirty..ninety + "half")
const NUM_WORDS: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
  half:0.5
};
function parseNumberWords(s: string): number | undefined {
  s = s.toLowerCase().trim().replace(/-/g, " ");
  if (NUM_WORDS[s] !== undefined) return NUM_WORDS[s];
  const parts = s.split(/\s+/);
  let total = 0; for (const p of parts) { if (NUM_WORDS[p]===undefined) return; total += NUM_WORDS[p]; }
  return total || undefined;
}

// Tags: [work] [home] OR leading "work, ..." / "work: ..."
function extractTagsAndText(s: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  // bracketed tags
  const tagRe = /\[(.+?)\]/g; let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) { const tag = m[1].trim(); if (tag) tags.push(tag.toLowerCase()); }
  if (tags.length) {
    const text = s.replace(tagRe, "").replace(/\s+/g, " ").trim();
    return { text, tags };
  }
  // leading tags before comma/colon
  const lead = s.match(/^\s*([a-z0-9_\-]+(?:\s*,\s*[a-z0-9_\-]+)*)\s*[:\,]\s*(.+)$/i);
  if (lead) {
    const tagList = lead[1].split(/\s*,\s*/).map(t => t.toLowerCase());
    const text = lead[2].trim();
    return { text, tags: tagList };
  }
  return { text: s.trim(), tags };
}

// Find and strip an inline time phrase anywhere: "today 5pm" | "tomorrow 9 am" | "in ten minutes" | "at 18:30"
function extractInlineExpiry(s: string): { clean: string; expiresAt?: number } {
  const orig = s;
  // in X minutes/hours (digits or words)
  const inRe = /\bin\s+((?:\d+|[a-z\- ]+))\s*(minutes?|minute|mins?|m|hours?|hour|hrs?|h)\b/i;
  let mi = s.match(inRe);
  if (mi) {
    const numTxt = mi[1].trim();
    const n = /^\d+$/.test(numTxt) ? parseInt(numTxt,10) : parseNumberWords(numTxt);
    if (n !== undefined) {
      const unit = mi[2][0].toLowerCase(); // m or h
      const delta = (unit === "h" ? n*3600 : n*60) * 1000;
      return { clean: s.replace(inRe, "").replace(/\s+/g," ").trim(), expiresAt: Date.now()+delta };
    }
  }
  // today/tomorrow time
  const dayRe = /\b(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const md = s.match(dayRe);
  if (md) {
    const base = md[1].toLowerCase() === "tomorrow" ? addDays(new Date(),1) : new Date();
    const ts = atToTs(base, parseInt(md[2],10), md[3]?parseInt(md[3],10):0, md[4]);
    return { clean: s.replace(dayRe,"").replace(/\s+/g," ").trim(), expiresAt: ts };
  }
  // at HH[:MM] am/pm (or 24h)
  const atRe = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const ma = s.match(atRe);
  if (ma) {
    const ts = atToTs(new Date(), parseInt(ma[1],10), ma[2]?parseInt(ma[2],10):0, ma[3]);
    return { clean: s.replace(atRe,"").replace(/\s+/g," ").trim(), expiresAt: ts };
  }
  return { clean: orig.trim() };
}
function atToTs(base: Date, h: number, m: number, ampm?: string) {
  let hh = h; if (ampm) { const ap = ampm.toLowerCase(); if (ap==="pm" && hh<12) hh+=12; if (ap==="am" && hh===12) hh=0; }
  const d = new Date(base); d.setSeconds(0,0); d.setHours(hh, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate()+1);
  return d.getTime();
}

// "remind me ..." parser (supports number words)
function parseReminderCommand(full: string): { dueTs?: number; msg?: string } {
  let s = full.toLowerCase().replace(/^\s*(hey\s+mira,\s*)?remind\s+me\s*/, "");
  s = s.replace(/^to\s+/, "");
  // in X minutes/hours
  const inRe = /\bin\s+((?:\d+|[a-z\- ]+))\s*(minutes?|minute|mins?|m|hours?|hour|hrs?|h)\b/;
  const mi = s.match(inRe);
  if (mi) {
    const numTxt = mi[1].trim();
    const n = /^\d+$/.test(numTxt) ? parseInt(numTxt,10) : parseNumberWords(numTxt);
    if (n !== undefined) {
      const unit = mi[2][0].toLowerCase();
      const delta = (unit==="h"? n*3600 : n*60) * 1000;
      const dueTs = Date.now()+delta;
      const msg = s.replace(inRe,"").trim() || "Reminder";
      return { dueTs, msg };
    }
  }
  // tomorrow ...
  const tomorrowRe = /\btomorrow\b/;
  if (tomorrowRe.test(s)) {
    const rest = s.replace(tomorrowRe,"").trim();
    const time = rest.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    const dueTs = time ? atToTs(addDays(new Date(),1), parseInt(time[1],10), time[2]?parseInt(time[2],10):0, time[3]) : atToTs(addDays(new Date(),1), 9, 0); // default 9:00
    const msg = rest.replace(time?.[0] ?? "","").replace(/^at\s*/,"").trim() || "Reminder";
    return { dueTs, msg };
  }
  // at HH[:MM] [am/pm]
  const atRe = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/;
  const ma = s.match(atRe);
  if (ma) {
    const dueTs = atToTs(new Date(), parseInt(ma[1],10), ma[2]?parseInt(ma[2],10):0, ma[3]);
    const msg = s.replace(ma[0],"").replace(/^at\s*/,"").trim() || "Reminder";
    return { dueTs, msg };
  }
  return {};
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }

/** ========== VOICE REGEXES ========= */
const NOTE_RE   = /^\s*(?:hey\s+mira,\s*)?(?:note|notes?)\s*[:\-]?\s*(.+)$/i;
const SHOW_RE   = /^\s*(?:hey\s+mira,\s*)?(?:show|show\s+me|display|open|list)\s+(?:my\s+|the\s+)?notes?(?:\s+([a-z0-9_\-]+))?\s*[\.\!\?]*\s*$/i;
const CLEAR_RE  = /^\s*(?:hey\s+mira,\s*)?(?:clear\s+note?s?|note?s?\s+clear|clear)\s*[\.\!\?]*\s*$/i;
const DELETE_RE = /^\s*(?:hey\s+mira,\s*)?(?:delete|remove)\s+(?:the\s+)?note\s+(last|\d+|[a-z]+)\s*[\.\!\?]*\s*$/i;
const UNDO_RE   = /^\s*(?:hey\s+mira,\s*)?(?:undo\s+(?:the\s+)?note|undo\s+last\s+note|undo\s+note|undo)\s*[\.\!\?]*\s*$/i;
const SEARCH_RE = /^\s*(?:hey\s+mira,\s*)?(?:search|find)\s+(?:my\s+)?notes?\s+(.+?)\s*[\.\!\?]*\s*$/i;

// Pin: "pin last" | "pin note 3" | "pin note three" | "pin work" | "pin buy milk"
const PIN_REX   = /^\s*(?:hey\s+mira,\s*)?pin\b(.*)$/i;
const UNPIN_RE  = /^\s*(?:hey\s+mira,\s*)?unpin(?:\s+note)?\s*[\.\!\?]*\s*$/i;

/** ========== PIN STATE ========= */
let pinnedText: string | null = null;

/** ========== EXPORT SERVER ========= */
function startExportServer() {
  Bun.serve({
    port: EXPORT_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/export/json") {
        return new Response(JSON.stringify(notes, null, 2), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/export/reminders.json") {
        return new Response(JSON.stringify(reminders, null, 2), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/export/csv") {
        const rows = [
          ["timestamp","time_hhmm","tags","text"],
          ...notes.map(n => [String(n.ts), formatTime(new Date(n.ts)), (n.tags??[]).join("|"), n.text.replace(/\r?\n/g," ")])
        ];
        const csv = rows.map(r => r.map(csvCell).join(",")).join("\n");
        return new Response(csv, { headers: { "content-type": "text/csv" } });
      }
      return new Response("OK: /export/json /export/csv /export/reminders.json", { status: 200 });
    },
  });
  console.log(`Export server on http://localhost:${EXPORT_PORT} (/export/json | /export/csv | /export/reminders.json)`);
}
function csvCell(s: string) { return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }

/** ========== UI HELPERS ========= */
function formatTime(d: Date) { const hh = String(d.getHours()).padStart(2,"0"); const mm = String(d.getMinutes()).padStart(2,"0"); return `${hh}:${mm}`; }
function formatNoteLine(n: NoteItem) { return `${formatTime(new Date(n.ts))}  ${n.text}`; }
function listNotesBody(items: NoteItem[]) {
  if (!items.length) return "No notes yet.";
  return items.map((n,i) => {
    const tagStr = n.tags?.length ? ` [${n.tags.join(",")}]` : "";
    const expStr = n.expiresAt ? ` (→ ${formatTime(new Date(n.expiresAt))})` : "";
    return `${String(i+1).padStart(2," ")}) ${formatNoteLine(n)}${tagStr}${expStr}`;
  }).join("\n").slice(0,1200);
}
function showCard(session: AppSession, title: string, body: string, durationMs = 4000) { void session.layouts.showReferenceCard(title, body, { durationMs }); }
async function tryWriteDashboard(session: AppSession, text: string) { try { await session.dashboard?.content?.writeToMain?.(text); } catch {} }
async function refreshDashboard(session: AppSession) {
  if (pinnedText) await tryWriteDashboard(session, `📌 ${pinnedText}`);
  else if (notes.length) await tryWriteDashboard(session, `📝 ${formatNoteLine(notes[0])}`);
  else await tryWriteDashboard(session, "");
}

/** ========== APP SERVER ========= */
class StickyNoteServer extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    session.logger.info({ sessionId, userId }, "session started");

    if (!loaded) await loadAll();
    scheduleAllReminders(session);
    showCard(session, "Sticky Note", 'Say: "note [work] send report" • "show notes work" • "remind me in ten minutes walk"', 4800);
    await refreshDashboard(session);

    session.events.onTranscription(async (d) => {
      if (!d.isFinal) return;
      const text = (d.text ?? "").trim();
      session.logger.info(`FINAL: "${text}"`);

      // CLEAR
      if (CLEAR_RE.test(text)) { clearAllNotes(); showCard(session,"Notes cleared","",1800); await refreshDashboard(session); return; }

      // SHOW (optional tag)
      { const m = text.match(SHOW_RE); if (m) { const tag = m[1]?.toLowerCase(); const items = tag ? notes.filter(n => n.tags?.includes(tag)) : notes; showCard(session, tag?`Notes: ${tag}`:"Notes", listNotesBody(items), 15000); return; } }

      // SEARCH
      { const m = text.match(SEARCH_RE); if (m) { const q = m[1].trim().toLowerCase(); const hits = notes.filter(n => n.text.toLowerCase().includes(q)); showCard(session, `Search: ${q}`, hits.length?listNotesBody(hits):`No notes matching "${q}".`, 15000); return; } }

      // DELETE n / last (number words supported)
      { const m = text.match(DELETE_RE); if (m) {
          const which = m[1].toLowerCase();
          let removed: NoteItem | null = null;
          if (which === "last") removed = undoLastNote();
          else if (/^\d+$/.test(which)) removed = deleteNoteIndex(parseInt(which,10));
          else { const n = parseNumberWords(which); if (n !== undefined) removed = deleteNoteIndex(n); }
          if (removed) { showCard(session,"Deleted", formatNoteLine(removed), 2500); await refreshDashboard(session); }
          else showCard(session,"Delete","No such note.",1800);
          return;
      } }

      // UNDO
      if (UNDO_RE.test(text)) { const r = undoLastNote(); if (r) { showCard(session,"Undone", formatNoteLine(r), 2500); await refreshDashboard(session); } else showCard(session,"Undo","Nothing to undo.",1800); return; }

      // UNPIN
      if (UNPIN_RE.test(text)) { pinnedText = null; showCard(session,"Unpinned","Dashboard cleared",1800); await refreshDashboard(session); return; }

      // PIN (smart)
      { const pm = text.match(PIN_REX); if (pm) {
          let arg = (pm[1] ?? "").trim().replace(/^[\:\-]\s*/, ""); // stuff after "pin"
          if (!arg) { showCard(session,"Pin","Say: pin last | pin note three | pin work", 2800); return; }
          let txt: string | null = null;

          // "pin last"
          if (/^last\b/i.test(arg)) txt = notes[0] ? formatNoteLine(notes[0]) : null;

          // "pin note <num/word>"
          const mNote = arg.match(/\bnote\s+([a-z0-9\-]+)\b/i);
          if (!txt && mNote) {
            const token = mNote[1].toLowerCase();
            let idx = /^\d+$/.test(token) ? parseInt(token,10) : (parseNumberWords(token) ?? NaN);
            if (!isNaN(idx!)) { const item = notes[idx!-1]; if (item) txt = formatNoteLine(item); }
          }

          // "pin <tag>" (if we have notes with that tag)
          if (!txt) {
            const tag = arg.toLowerCase().trim().replace(/[\.!\?]+$/,"");
            const byTag = notes.find(n => n.tags?.includes(tag));
            if (byTag) txt = formatNoteLine(byTag);
          }

          // Otherwise: treat as free text
          if (!txt) txt = arg;

          pinnedText = txt;
          showCard(session, "Pinned", txt, 2500);
          await refreshDashboard(session);
          return;
      } }

      // REMINDERS
      { const rm = parseReminderCommand(text); if (rm.dueTs && rm.msg) {
          const r: Reminder = { id: id(), text: rm.msg, dueTs: rm.dueTs, createdTs: Date.now() };
          reminders.unshift(r); scheduleReminder(session, r); scheduleSave();
          showCard(session, "Reminder set", `${formatTime(new Date(r.dueTs))}  ${r.text}`, 3500);
          return;
      } }

      // ADD NOTE (tags + inline time anywhere)
      { const nm = text.match(NOTE_RE); if (nm) {
          // tags
          let { text: clean, tags } = extractTagsAndText(nm[1]);
          // expiry (look anywhere, not just parentheses)
          const exp = extractInlineExpiry(clean); clean = exp.clean;

          const note: NoteItem = { text: clean, ts: Date.now() };
          if (tags.length) note.tags = tags;
          if (exp.expiresAt) note.expiresAt = exp.expiresAt;

          addNote(note);
          const tagStr = note.tags?.length ? ` [${note.tags.join(",")}]` : "";
          const expStr = note.expiresAt ? ` (→ ${formatTime(new Date(note.expiresAt))})` : "";
          showCard(session, "Note", `${note.text}${tagStr}${expStr}`, 6000);

          if (note.expiresAt) {
            const r: Reminder = { id: id(), text: `Note: ${note.text}`, dueTs: note.expiresAt, createdTs: Date.now() };
            reminders.unshift(r); scheduleReminder(session, r); scheduleSave();
          }

          await refreshDashboard(session);
          return;
      } }
    });
  }
}

/** ========== EXPORTS & START ========= */
function startExportServer() {
  Bun.serve({
    port: EXPORT_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/export/json")
        return new Response(JSON.stringify(notes, null, 2), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/export/reminders.json")
        return new Response(JSON.stringify(reminders, null, 2), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/export/csv") {
        const rows = [["timestamp","time_hhmm","tags","text"], ...notes.map(n => [String(n.ts), formatTime(new Date(n.ts)), (n.tags??[]).join("|"), n.text.replace(/\r?\n/g," ")])];
        const csv = rows.map(r => r.map(s => /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s).join(",")).join("\n");
        return new Response(csv, { headers: { "content-type": "text/csv" } });
      }
      return new Response("OK: /export/json /export/csv /export/reminders.json", { status: 200 });
    },
  });
  console.log(`Export server on http://localhost:${EXPORT_PORT} (/export/json | /export/csv | /export/reminders.json)`);
}
startExportServer();

new StickyNoteServer({
  packageName: process.env.PACKAGE_NAME ?? "com.pavan.stickynote",
  apiKey: process.env.MENTRAOS_API_KEY!,
  port: APP_PORT,
}).start();
