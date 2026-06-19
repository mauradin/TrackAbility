/* =====================================================================
   TrackAbility — application logic
   Firestore (shared, live sync) + EmailJS (nudges)

   Flow: pick an operative -> today's log opens automatically.
   A fresh date is auto-created each new day (midnight America/New_York).
   The operative's full history lives in the dates sub-rail.

   Data model:
     people/<personId> { name, email, createdAt }
       days/<YYYY-MM-DD> { date, note, tasks:[{id,text,status}], updatedAt }
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot,
  serverTimestamp, query, orderBy, getDocs, writeBatch, deleteDoc, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = window.APP_CONFIG;

/* ---------- init ---------- */
const fbApp = initializeApp(CFG.firebase);
const db = getFirestore(fbApp);

let emailReady = false;
try {
  if (window.emailjs && CFG.emailjs.publicKey && !CFG.emailjs.publicKey.startsWith("PASTE")) {
    emailjs.init({ publicKey: CFG.emailjs.publicKey });
    emailReady = true;
  }
} catch (e) { console.warn("EmailJS init failed", e); }

/* the public forum is stored under a reserved "person" id so it rides the
   existing Firestore rules; it is hidden from the operatives list. */
const FORUM_ID = "__dayfeed__";

/* ---------- state ---------- */
const state = {
  people: [],                 // [{id,name,email}]
  daysByPerson: {},           // personId -> [{id(date), tasks, note}]
  dayUnsubs: {},              // personId -> unsubscribe fn for its days
  daySub: null,               // active single-day listener
  selPerson: null,            // personId
  selDate: null,              // 'YYYY-MM-DD'
  curDay: null,               // active day doc data
  view: "list",
  screen: "feed",             // "feed" (public forum, default home) | "day"
  forum: [],                  // public feed posts (newest-first)
  forumSub: null              // forum listener unsubscribe
};

/* ---------- helpers ---------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => (s??"").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const initials = n => (n||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
const uid = () => "t" + Math.random().toString(36).slice(2,9) + (performance.now()|0).toString(36);
// Which bucket a task lives in. "backlog" is a normal, freely-movable status;
// the legacy `backlog:true` flag (from older docs) is still honored for compat.
const taskBucket = t => {
  if(t.status === "backlog") return "backlog";
  if(t.backlog && t.status !== "done") return "backlog";   // legacy flag
  return t.status || "todo";
};

// "today" anchored to America/New_York (EST/EDT) -> YYYY-MM-DD
function estTodayStr(){
  return new Intl.DateTimeFormat("en-CA",{ timeZone:"America/New_York",
    year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}
function fmtDate(s){
  const [y,m,d]=s.split("-").map(Number);
  const dt=new Date(y,m-1,d);
  return dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric"});
}
// epoch-ms -> short local time, e.g. "2:14 PM"
function fmtTime(ms){
  if(!ms) return "";
  return new Date(ms).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
}
// epoch-ms -> date + time for the cross-day forum, e.g. "Jun 19, 2:14 PM"
function fmtStamp(ms){
  if(!ms) return "";
  return new Date(ms).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}
let toastT;
function toast(msg, isErr=false){
  const t=$("#toast"); t.textContent=msg; t.className="toast"+(isErr?" err":"");
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add("hidden"),3600);
}

/* =====================================================================
   PEOPLE  (live)
   ===================================================================== */
onSnapshot(collection(db,"people"),
  snap => {
    state.people = snap.docs.map(d=>({id:d.id, ...d.data()}))
                       .filter(p=>p.id!==FORUM_ID)   // the forum is not an operative
                       .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
    state.people.forEach(p => subscribeDays(p.id));
    renderOps();
    setSync(true);
  },
  err => { console.error(err); setSync(false); toast("Sync error — check Firestore rules.", true); }
);

function subscribeDays(personId){
  if (state.dayUnsubs[personId]) return;
  const q = query(collection(db,"people",personId,"days"), orderBy("date","desc"));
  state.dayUnsubs[personId] = onSnapshot(q, snap=>{
    state.daysByPerson[personId] = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderOps();
    if (state.selPerson===personId) renderDateList();
  });
}

/* =====================================================================
   TIER 1 — operatives list (simple; select -> open today)
   ===================================================================== */
function isBehind(personId){
  const days = state.daysByPerson[personId];
  if(!days) return false;
  const today = days.find(d=>d.id===estTodayStr());
  if(!today) return true;
  const tasks = today.tasks||[];
  if(!tasks.length) return true;
  return !tasks.some(t=>t.status==="done");
}

function renderOps(){
  const wrap=$("#peopleList");
  if(!state.people.length){
    wrap.innerHTML=`<div class="date-empty">No operatives yet. Hit + to deploy one.</div>`;
    return;
  }
  wrap.innerHTML = state.people.map(p=>{
    const sel = state.screen!=="feed" && state.selPerson===p.id;
    const days = state.daysByPerson[p.id]||[];
    const behind = isBehind(p.id);
    const flag = behind
      ? `<span class="person-flag behind">BEHIND</span>`
      : (days.length ? `<span class="person-flag ok">ON TRACK</span>` : "");
    return `
      <div class="op-row ${sel?"sel":""}" data-act="selectop" data-p="${p.id}">
        <span class="person-badge">${esc(initials(p.name))}</span>
        <span class="person-name">${esc(p.name)}</span>
        ${flag}
        <button class="op-del" data-act="delop" data-p="${p.id}" title="Remove operative">×</button>
      </div>`;
  }).join("");
}

$("#peopleList").addEventListener("click", e=>{
  const del = e.target.closest("[data-act='delop']");
  if(del){ e.stopPropagation(); confirmDeletePerson(del.dataset.p); return; }
  const el = e.target.closest("[data-act='selectop']"); if(!el) return;
  selectPerson(el.dataset.p);
});

function confirmDeletePerson(personId){
  const p=state.people.find(x=>x.id===personId); if(!p) return;
  const n=(state.daysByPerson[personId]||[]).length;
  if(!confirm(`Delete operative "${p.name}" and all ${n} logged day(s)? This cannot be undone.`)) return;
  deletePerson(personId)
    .then(()=>toast(`Operative "${p.name}" removed.`))
    .catch(e=>{ console.error(e); toast("Delete failed — check Firestore rules.", true); });
}

async function deletePerson(personId){
  // Client SDK doesn't cascade — delete every day doc, then the person, in one batch.
  const daysSnap = await getDocs(collection(db,"people",personId,"days"));
  const batch = writeBatch(db);
  daysSnap.forEach(d=>batch.delete(d.ref));
  batch.delete(doc(db,"people",personId));
  await batch.commit();

  // tear down local listeners + state for the removed operative
  if(state.dayUnsubs[personId]){ state.dayUnsubs[personId](); delete state.dayUnsubs[personId]; }
  delete state.daysByPerson[personId];
  if(state.selPerson===personId){
    if(state.daySub){ state.daySub(); state.daySub=null; }
    state.selPerson=null; state.selDate=null; state.curDay=null;
    renderDateList();
    showFeed();   // fall back to the public feed
  }
}

function selectPerson(personId){
  state.selPerson = personId;
  renderOps();
  const today = estTodayStr();
  openDay(personId, today);                     // open immediately (optimistic)
  renderDateList();
  ensureToday(personId).catch(e=>console.error("ensureToday failed", e));  // create in background
}

/* =====================================================================
   TIER 2 — dates sub-rail (history)
   ===================================================================== */
function renderDateList(){
  const person = state.people.find(p=>p.id===state.selPerson);
  $("#datesOpName").textContent = person ? person.name.toUpperCase() : "SELECT OPERATIVE";
  const pane=$("#dateList");
  if(!person){ pane.innerHTML=`<div class="date-empty">Choose an operative to view their daily logs.</div>`; return; }

  const days = state.daysByPerson[state.selPerson]||[];   // already newest-first
  const today = estTodayStr();
  if(!days.length){ pane.innerHTML=`<div class="date-empty">No logs yet.</div>`; return; }

  pane.innerHTML = days.map(d=>{
    const tasks=d.tasks||[];
    const done=tasks.filter(t=>t.status==="done").length;
    const active = state.selDate===d.id;
    const isToday = d.id===today;
    const complete = tasks.length>0 && done===tasks.length;
    const badge = isToday ? `<span class="di-today">TODAY</span>`
                          : (complete ? `<span class="di-check">✓</span>` : "");
    return `<div class="date-item ${active?"active":""} ${isToday?"today":""}" data-act="openday" data-d="${d.id}">
              <span class="di-label">${esc(fmtDate(d.id))}</span>
              ${badge}
              <span class="di-prog">${done}/${tasks.length}</span>
            </div>`;
  }).join("");
}

$("#dateList").addEventListener("click", e=>{
  const el=e.target.closest("[data-act='openday']"); if(!el||!state.selPerson) return;
  openDay(state.selPerson, el.dataset.d);
});

/* =====================================================================
   WRITES
   ===================================================================== */
async function addPerson(name, email){
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || uid();
  await setDoc(doc(db,"people",id), { name, email:email||"", createdAt:serverTimestamp() });
  selectPerson(id);
  toast(`Operative "${name}" deployed.`);
}

// Seed a fresh day's backlog from the latest prior day: anything not completed
// rolls forward as a locked backlog task (carried-over backlog included).
function carryForwardBacklog(personId, todayId){
  const days = state.daysByPerson[personId] || [];   // already newest-first
  const prev = days.find(d => d.id < todayId);        // most recent earlier day
  if(!prev) return [];
  return (prev.tasks||[])
    .filter(t => taskBucket(t) !== "done")
    .map(t => ({ id: uid(), text: t.text, status: "backlog",
                 createdAt: Date.now(), completedAt: null }));
}

// create today's date doc if it doesn't already exist; returns today's id
async function ensureToday(personId){
  const d = estTodayStr();
  const existing = (state.daysByPerson[personId]||[]).find(x=>x.id===d);
  if(!existing){
    await setDoc(doc(db,"people",personId,"days",d),
      { date:d, note:"", tasks:carryForwardBacklog(personId,d), updatedAt:serverTimestamp() });
  }
  return d;
}

async function persistDay(){
  if(!state.selPerson||!state.selDate||!state.curDay) return;
  // merge so we never clobber the day's feed (written on its own path)
  await setDoc(doc(db,"people",state.selPerson,"days",state.selDate),{
    date: state.selDate,
    note: state.curDay.note||"",
    tasks: state.curDay.tasks||[],
    updatedAt: serverTimestamp()
  }, { merge:true });
}

/* =====================================================================
   DAY VIEW
   ===================================================================== */
function openDay(personId, date){
  state.selPerson=personId; state.selDate=date; state.screen="day";
  maybeCloseDrawer();
  if(state.daySub){ state.daySub(); state.daySub=null; }
  $("#feedNav").classList.remove("active");
  $("#feedView").classList.add("hidden");
  $("#welcome").classList.add("hidden");
  $("#dayView").classList.remove("hidden");
  renderDateList(); // refresh active highlight

  const ref=doc(db,"people",personId,"days",date);
  state.daySub = onSnapshot(ref, snap=>{
    state.curDay = snap.exists() ? snap.data() : { date, note:"", tasks:[] };
    renderDay();
    renderOps();
    renderDateList();
  });
}

function renderDay(){
  const person = state.people.find(p=>p.id===state.selPerson);
  $("#crumbPerson").textContent = person ? person.name : "—";
  $("#crumbDate").textContent = state.selDate || "—";
  $("#dayTitle").textContent = state.selDate ? fmtDate(state.selDate).toUpperCase() : "DAILY LOG";

  const noteEl=$("#noteArea");
  if(document.activeElement!==noteEl) noteEl.value = state.curDay.note||"";

  if(state.view==="list") renderList(); else renderKanban();
}

// created / completed stamps shown subtly on each task
function taskStamp(t){
  const made = t.createdAt ? `<span title="Created">⊕ ${fmtTime(t.createdAt)}</span>` : "";
  const done = t.completedAt ? `<span class="done" title="Completed">✓ ${fmtTime(t.completedAt)}</span>` : "";
  return (made||done) ? `<span class="task-time">${made}${done}</span>` : "";
}
function taskRow(t){
  const bucket=taskBucket(t);
  // backlog is just another status now — fully draggable, and the pill cycles
  // through it like any other bucket.
  return `<div class="task${bucket==="backlog"?" backlog":""}" draggable="true" data-status="${bucket}" data-id="${t.id}">
      <span class="task-grip" title="Drag to reorder" aria-hidden="true">⠿</span>
      <div class="check" data-act="check">✓</div>
      <div class="task-text">${esc(t.text)}${taskStamp(t)}</div>
      <button class="status-pill${bucket==="backlog"?" backlog":""}" data-act="cycle" title="Click to change status">${bucket.toUpperCase()}</button>
      <button class="task-del" data-act="del" title="Remove">×</button>
    </div>`;
}

function renderList(){
  $("#listView").classList.remove("hidden");
  $("#kanbanView").classList.add("hidden");
  const tasks=state.curDay.tasks||[];
  const wrap=$("#listView");
  if(!tasks.length){ wrap.innerHTML=`<div class="empty-tasks">No objectives logged for this day. Add one above.</div>`; return; }
  wrap.innerHTML = tasks.map(taskRow).join("");   // flat, stored order (drag-reorderable)
}

function kanStamp(t){
  const made = t.createdAt ? `⊕ ${fmtTime(t.createdAt)}` : "";
  const done = t.completedAt ? `✓ ${fmtTime(t.completedAt)}` : "";
  return (made||done) ? `<div class="kc-time">${made}${made&&done?" · ":""}${done}</div>` : "";
}
function renderKanban(){
  $("#listView").classList.add("hidden");
  $("#kanbanView").classList.remove("hidden");
  const tasks=state.curDay.tasks||[];
  ["backlog","todo","doing","done"].forEach(stat=>{
    const body=$(`.kan-body[data-drop="${stat}"]`);
    const col=tasks.filter(t=>taskBucket(t)===stat);
    $(`.kan-col[data-status="${stat}"] [data-count]`).textContent=col.length;
    body.innerHTML = col.map(t=>`
      <div class="kan-card" draggable="true" data-id="${t.id}">
        ${esc(t.text)}
        ${kanStamp(t)}
        <button class="kc-del" data-act="del" data-id="${t.id}" title="Remove">×</button>
      </div>`).join("");
  });
}

/* task mutations */
function setTasks(fn){ state.curDay.tasks = fn([...(state.curDay.tasks||[])]); persistDay(); }
function addTask(text){
  if(!text.trim()) return;
  setTasks(ts=>[...ts,{id:uid(),text:text.trim(),status:"todo",createdAt:Date.now(),completedAt:null}]);
}
function delTask(id){ setTasks(ts=>ts.filter(t=>t.id!==id)); }
// stamp completedAt whenever a task lands in "done"; clear it when it leaves.
// Also drops the legacy `backlog` flag — status is now the single source of truth.
function setStatus(id,status){
  setTasks(ts=>ts.map(t=>t.id!==id ? t
    : {...t, status, backlog:false, completedAt: status==="done" ? (t.completedAt||Date.now()) : null}));
}
function cycleStatus(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  const next={backlog:"todo",todo:"doing",doing:"done",done:"backlog"};
  setStatus(id, next[taskBucket(cur||{})] || "todo");
}
function toggleDone(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  setStatus(id, taskBucket(cur||{})==="done" ? "todo" : "done");
}

/* list interactions */
$("#listView").addEventListener("click", e=>{
  const el=e.target.closest("[data-act]"); if(!el) return;
  const id=el.closest(".task")?.dataset.id; if(!id) return;
  if(el.dataset.act==="check") toggleDone(id);
  else if(el.dataset.act==="cycle") cycleStatus(id);
  else if(el.dataset.act==="del") delTask(id);
});

/* list drag-to-reorder — rewrites the stored task sequence */
function reorderByIds(ids){
  setTasks(ts=>{
    const byId=new Map(ts.map(t=>[t.id,t]));
    const next=ids.map(id=>byId.get(id)).filter(Boolean);
    ts.forEach(t=>{ if(!ids.includes(t.id)) next.push(t); }); // safety: keep any stragglers
    return next;
  });
}
function dragAfterTask(container, y){
  const els=[...container.querySelectorAll(".task:not(.dragging)")];
  return els.reduce((closest, el)=>{
    const box=el.getBoundingClientRect();
    const offset=y - box.top - box.height/2;
    return (offset<0 && offset>closest.offset) ? {offset, el} : closest;
  }, {offset:Number.NEGATIVE_INFINITY, el:null}).el;
}
let listDragId=null;
$("#listView").addEventListener("dragstart", e=>{
  const t=e.target.closest(".task"); if(!t) return;
  listDragId=t.dataset.id; t.classList.add("dragging");
  e.dataTransfer.effectAllowed="move";
});
$("#listView").addEventListener("dragover", e=>{
  if(!listDragId) return;
  e.preventDefault();
  const dragging=$("#listView .task.dragging"); if(!dragging) return;
  const after=dragAfterTask($("#listView"), e.clientY);
  if(after==null) $("#listView").appendChild(dragging);
  else $("#listView").insertBefore(dragging, after);
});
$("#listView").addEventListener("drop", e=>{
  if(!listDragId) return;
  e.preventDefault();
  const ids=$$("#listView .task").map(el=>el.dataset.id);
  listDragId=null;
  reorderByIds(ids); // persists; live snapshot re-renders the canonical order
});
$("#listView").addEventListener("dragend", e=>{
  e.target.closest(".task")?.classList.remove("dragging");
  listDragId=null;
});

/* kanban interactions */
$("#kanbanView").addEventListener("click", e=>{
  const act=e.target.closest("[data-act]"); if(!act) return;
  if(act.dataset.act==="del") delTask(act.dataset.id);
  else if(act.dataset.act==="check") toggleDone(act.dataset.id);
});
let dragId=null;
$("#kanbanView").addEventListener("dragstart", e=>{
  const card=e.target.closest(".kan-card"); if(!card) return;
  dragId=card.dataset.id; card.classList.add("dragging");
});
$("#kanbanView").addEventListener("dragend", e=>{
  e.target.closest(".kan-card")?.classList.remove("dragging");
  $$(".kan-body").forEach(b=>b.classList.remove("drag-over"));
});
$$(".kan-body[data-drop]").forEach(body=>{   // backlog column is not a drop target
  body.addEventListener("dragover", e=>{ e.preventDefault(); body.classList.add("drag-over"); });
  body.addEventListener("dragleave", ()=>body.classList.remove("drag-over"));
  body.addEventListener("drop", e=>{
    e.preventDefault(); body.classList.remove("drag-over");
    if(dragId) setStatus(dragId, body.dataset.drop);
    dragId=null;
  });
});

/* task entry */
$("#addTaskBtn").addEventListener("click", ()=>{ const i=$("#taskInput"); addTask(i.value); i.value=""; i.focus(); });
$("#taskInput").addEventListener("keydown", e=>{ if(e.key==="Enter"){ addTask(e.target.value); e.target.value=""; } });

/* view toggle */
$$(".view-btn").forEach(btn=>btn.addEventListener("click", ()=>{
  $$(".view-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  state.view=btn.dataset.view;
  renderDay();
}));

/* note autosave */
let noteT;
$("#noteArea").addEventListener("input", e=>{
  state.curDay.note=e.target.value;
  $("#noteStatus").textContent="saving…"; $("#noteStatus").className="note-status saving";
  clearTimeout(noteT);
  noteT=setTimeout(async ()=>{
    await persistDay();
    $("#noteStatus").textContent="saved"; $("#noteStatus").className="note-status saved";
  }, 700);
});

/* =====================================================================
   MODALS
   ===================================================================== */
const personModal=$("#personModal");
$("#addPersonBtn").addEventListener("click", ()=>{ $("#personName").value=""; $("#personEmail").value=""; personModal.classList.remove("hidden"); $("#personName").focus(); });
$("#personCancel").addEventListener("click", ()=>personModal.classList.add("hidden"));
$("#personSave").addEventListener("click", async ()=>{
  const name=$("#personName").value.trim(); const email=$("#personEmail").value.trim();
  if(!name){ toast("Name required.", true); return; }
  personModal.classList.add("hidden");
  try{ await addPerson(name,email); }catch(e){ console.error(e); toast("Save failed — check Firestore rules.", true); }
});

/* =====================================================================
   EMAIL — one reusable sender used by both the nudge and the feed push.
   EmailJS always renders a template, so we pass the custom subject + body
   as params; add {{subject}} to your template to surface the subject line.
   ===================================================================== */
async function sendEmail(person, subject, message){
  if(!emailReady) throw new Error("EmailJS not configured yet (need Service ID).");
  // Send the address under several common variable names so it maps no matter
  // which one the EmailJS template's "To Email" field references.
  const params = {
    to_email: person.email, email: person.email, user_email: person.email,
    recipient: person.email, to: person.email, reply_to: person.email,
    to_name: person.name, name: person.name,
    from_name: CFG.myName||"A friend",
    subject: subject||"TrackAbility", title: subject||"",
    message,
    days_behind: isBehind(person.id) ? "behind" : "on track"
  };
  return emailjs.send(CFG.emailjs.serviceId, CFG.emailjs.templateId, params);
}

/* nudge — a full custom composer (subject + body) for the open operative */
const nudgeModal=$("#nudgeModal");
$("#nudgeBtn").addEventListener("click", ()=>{ if(state.selPerson) openNudge(state.selPerson); });
function openNudge(personId){
  const p=state.people.find(x=>x.id===personId); if(!p) return;
  if(!p.email){ toast(`${p.name} has no email on file.`, true); return; }
  const behind=isBehind(personId);
  $("#nudgeSummary").innerHTML = behind
    ? `<b>${esc(p.name)}</b> looks <b>behind</b> on today's log. Fire off a friendly nudge to <b>${esc(p.email)}</b>.`
    : `Send a custom message to <b>${esc(p.name)}</b> at <b>${esc(p.email)}</b>.`;
  $("#nudgeSubject").value = `Accountability check-in`;
  $("#nudgeMsg").value = `Hey ${p.name}, just checking in — don't forget to log your accountability tracker today. Let's keep the streak going! 💪`;
  nudgeModal.dataset.target=personId;
  nudgeModal.classList.remove("hidden");
  $("#nudgeSubject").focus();
}
$("#nudgeCancel").addEventListener("click", ()=>nudgeModal.classList.add("hidden"));
$("#nudgeSend").addEventListener("click", async ()=>{
  const p=state.people.find(x=>x.id===nudgeModal.dataset.target); if(!p) return;
  if(!emailReady){ toast("EmailJS not configured yet (need Service ID).", true); return; }
  const btn=$("#nudgeSend"); btn.disabled=true; btn.textContent="SENDING…";
  try{
    await sendEmail(p, $("#nudgeSubject").value.trim(), $("#nudgeMsg").value);
    toast(`Message sent to ${p.name}.`);
    nudgeModal.classList.add("hidden");
  }catch(e){
    console.error("EmailJS error:", e);
    const detail = (e && (e.text || e.message)) ? `${e.status||""} ${e.text||e.message}`.trim() : "unknown error";
    toast(`Email failed: ${detail}`, true);
  }
  finally{ btn.disabled=false; btn.textContent="▸ SEND"; }
});

/* close modals on backdrop click / Esc */
[personModal,nudgeModal].forEach(m=>m.addEventListener("click", e=>{ if(e.target===m) m.classList.add("hidden"); }));
document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ personModal.classList.add("hidden"); nudgeModal.classList.add("hidden"); }});

/* =====================================================================
   DAY FEED — a single PUBLIC forum shared across every operative.
   Each post is its own doc under people/<FORUM_ID>/days, so the wall scales
   past the 1 MB single-document limit and stays live for everyone.
   FORUM_ID is filtered out of the operatives list (see people snapshot).
   ===================================================================== */
const MAX_IMG_BYTES = 950000;   // a single post doc must stay under ~1 MiB
let pendingFeedImg = null;      // staged data-URI awaiting POST

// Stored feed images are untrusted (no-auth DB). Only render a strict, fully
// base64 data-URI — this prevents an attribute breakout / onerror injection.
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const forumCol = () => collection(db,"people",FORUM_ID,"days");

function subscribeForum(){
  if(state.forumSub) return;
  const q=query(forumCol(), orderBy("ts","desc"), limit(60));   // cap history we load
  state.forumSub = onSnapshot(q,
    snap=>{ state.forum = snap.docs.map(d=>({id:d.id, ...d.data()})); renderForum(); },
    err=>console.error("forum sync", err));
}

function renderForum(){
  const list=$("#feedList"); if(!list) return;
  const feed=state.forum||[];   // already newest-first from the query
  if(!feed.length){ list.innerHTML=`<div class="feed-empty">Nothing here yet — be the first to post.</div>`; return; }
  list.innerHTML = feed.map(f=>{
    const img = (f.image && SAFE_IMG.test(f.image))
      ? `<img class="feed-img" src="${f.image}" alt="feed image" loading="lazy">` : "";
    const txt = f.text ? `<div class="feed-text">${esc(f.text)}</div>` : "";
    return `<div class="feed-item" data-id="${f.id}">
      <div class="feed-meta">
        <span class="feed-author">${esc(f.author||"—")}</span>
        <span class="feed-ts">${fmtStamp(f.ts)}</span>
        <button class="feed-del" data-act="feeddel" data-id="${f.id}" title="Remove">×</button>
      </div>
      ${img}${txt}
    </div>`;
  }).join("");
}

function compressImage(file, maxDim=1100, quality=0.62){
  return new Promise((resolve,reject)=>{
    const fr=new FileReader();
    fr.onerror=()=>reject(new Error("Could not read file"));
    fr.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const scale=Math.min(1, maxDim/Math.max(img.width,img.height));
        const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
        const c=document.createElement("canvas"); c.width=w; c.height=h;
        c.getContext("2d").drawImage(img,0,0,w,h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror=()=>reject(new Error("Not a valid image"));
      img.src=fr.result;
    };
    fr.readAsDataURL(file);
  });
}
async function stageImage(file){
  if(!file || !file.type.startsWith("image/")){ toast("That's not an image.", true); return; }
  try{
    let data = await compressImage(file);
    if(data.length > 600000) data = await compressImage(file, 800, 0.5);  // shrink further if still heavy
    pendingFeedImg = data;
    const prev=$("#feedImgPreview");
    prev.innerHTML = `<img src="${data}" alt="preview"><button id="feedImgClear" title="Remove image">×</button>`;
    prev.classList.remove("hidden");
  }catch(e){ console.error(e); toast(e.message||"Image failed.", true); }
}
function clearStagedImage(){
  pendingFeedImg=null;
  const prev=$("#feedImgPreview"); prev.innerHTML=""; prev.classList.add("hidden");
}
async function postForum(){
  const text=$("#feedText").value.trim();
  if(!text && !pendingFeedImg) return;
  if(pendingFeedImg && pendingFeedImg.length > MAX_IMG_BYTES){ toast("That image is too large — try a smaller one.", true); return; }
  const img=pendingFeedImg;
  $("#feedText").value=""; clearStagedImage();
  try{
    await setDoc(doc(db,"people",FORUM_ID,"days",uid()),
      { text, image:img||"", author:CFG.myName||"Anon", ts:Date.now(), createdAt:serverTimestamp() });
  }catch(e){ console.error(e); toast("Post failed — image may be too large.", true); }
}
async function delForum(id){
  try{ await deleteDoc(doc(db,"people",FORUM_ID,"days",id)); }
  catch(e){ console.error(e); toast("Delete failed.", true); }
}

/* feed wiring */
$("#feedPost").addEventListener("click", postForum);
$("#feedText").addEventListener("keydown", e=>{ if(e.key==="Enter" && (e.metaKey||e.ctrlKey)) postForum(); });
$("#feedImg").addEventListener("change", e=>{ if(e.target.files[0]) stageImage(e.target.files[0]); e.target.value=""; });
$("#feedImgPreview").addEventListener("click", e=>{ if(e.target.id==="feedImgClear") clearStagedImage(); });
$("#feedList").addEventListener("click", e=>{
  const del=e.target.closest('[data-act="feeddel"]'); if(del) delForum(del.dataset.id);
});
const feedCompose=$("#feedCompose");
["dragover","dragenter"].forEach(ev=>feedCompose.addEventListener(ev, e=>{ e.preventDefault(); feedCompose.classList.add("drop-hot"); }));
["dragleave","dragend"].forEach(ev=>feedCompose.addEventListener(ev, ()=>feedCompose.classList.remove("drop-hot")));
feedCompose.addEventListener("drop", e=>{
  e.preventDefault(); feedCompose.classList.remove("drop-hot");
  const file=[...(e.dataTransfer.files||[])].find(f=>f.type.startsWith("image/"));
  if(file) stageImage(file);
});
$("#feedText").addEventListener("paste", e=>{
  const item=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith("image/"));
  if(item){ e.preventDefault(); stageImage(item.getAsFile()); }
});

/* show the forum (home / default screen) */
function showFeed(){
  state.screen="feed";
  maybeCloseDrawer();
  $("#welcome").classList.add("hidden");
  $("#dayView").classList.add("hidden");
  $("#feedView").classList.remove("hidden");
  $("#feedNav").classList.add("active");
  renderOps();          // drop the operative highlight while on the feed
  renderForum();
}
$("#feedNav").addEventListener("click", showFeed);

/* broadcast the latest feed to every operative with an email (reuses sendEmail) */
$("#feedPushBtn").addEventListener("click", async ()=>{
  if(!emailReady){ toast("EmailJS not configured yet (need Service ID).", true); return; }
  const recipients=state.people.filter(p=>p.email);
  if(!recipients.length){ toast("No operatives have an email on file.", true); return; }
  const feed=[...(state.forum||[])].sort((a,b)=>(a.ts||0)-(b.ts||0)).slice(-25);
  if(!feed.length){ toast("Nothing in the feed to push yet.", true); return; }
  if(!confirm(`Email the latest ${feed.length} feed post(s) to all ${recipients.length} operative(s) with an address?`)) return;
  let imgs=0;
  const lines=feed.map(f=>{
    if(f.image) imgs++;
    const body=f.text || (f.image ? "[image]" : "");
    return `• ${fmtStamp(f.ts)} — ${f.author||"—"}: ${body}${f.text&&f.image?" [+image]":""}`;
  });
  const note=imgs ? `\n\n(${imgs} image${imgs>1?"s":""} posted — open TrackAbility to view.)` : "";
  const msg=`TrackAbility — Day Feed:\n\n${lines.join("\n")}${note}`;
  const btn=$("#feedPushBtn"), lbl=btn.textContent; btn.disabled=true; btn.textContent="SENDING…";
  let ok=0;
  for(const p of recipients){
    try{ await sendEmail(p, "TrackAbility — Day Feed", msg); ok++; }
    catch(e){ console.error("push to", p.name, e); }
  }
  btn.disabled=false; btn.textContent=lbl;
  toast(`Feed pushed to ${ok}/${recipients.length} operative(s).`, ok===0);
});

subscribeForum();
showFeed();   // public feed is the default home screen

/* =====================================================================
   OPERATIVE CONTEXT MENU — right-click a row to delete
   ===================================================================== */
const opMenu=$("#opMenu");
$("#peopleList").addEventListener("contextmenu", e=>{
  const row=e.target.closest("[data-act='selectop']"); if(!row) return;
  e.preventDefault();
  opMenu.dataset.p=row.dataset.p;
  opMenu.style.left=Math.min(e.clientX, window.innerWidth-170)+"px";
  opMenu.style.top =Math.min(e.clientY, window.innerHeight-60)+"px";
  opMenu.classList.remove("hidden");
});
function hideOpMenu(){ opMenu.classList.add("hidden"); }
$("#opMenuDelete").addEventListener("click", ()=>{
  const id=opMenu.dataset.p; hideOpMenu();
  if(id) confirmDeletePerson(id);
});
document.addEventListener("click", e=>{ if(!e.target.closest("#opMenu")) hideOpMenu(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape") hideOpMenu(); });
$("#peopleList").addEventListener("scroll", hideOpMenu);

/* =====================================================================
   SIDEBAR COLLAPSE  (desktop slide-away + mobile drawer)
   ===================================================================== */
const isMobile = () => window.matchMedia("(max-width:820px)").matches;
function setNav(collapsed, remember=true){
  document.body.classList.toggle("nav-collapsed", collapsed);
  if(remember && !isMobile()) localStorage.setItem("ta_nav_collapsed", collapsed ? "1" : "0");
}
setNav(isMobile() ? true : localStorage.getItem("ta_nav_collapsed")==="1", false);
$("#navCollapse").addEventListener("click", ()=>setNav(true));
$("#navReopen").addEventListener("click", ()=>setNav(false));
$("#navBackdrop").addEventListener("click", ()=>setNav(true));
function maybeCloseDrawer(){ if(isMobile()) setNav(true, false); }

/* =====================================================================
   DAILY ROLLOVER — at America/New_York midnight, append the new day
   for the selected operative and jump to it.
   ===================================================================== */
function msToNextEstMidnight(){
  const now = new Date();
  // current wall-clock in New York
  const est = new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
  const next = new Date(est);
  next.setHours(24,0,8,0);              // 00:00:08 just after midnight
  return Math.max(1000, next - est);
}
function scheduleRollover(){
  setTimeout(async ()=>{
    if(state.selPerson){
      try{
        const today = await ensureToday(state.selPerson);
        renderDateList();
        openDay(state.selPerson, today);
        toast("New day logged — fresh objectives await.");
      }catch(e){ console.error(e); }
    }
    scheduleRollover();                 // re-arm for the following midnight
  }, msToNextEstMidnight());
}
scheduleRollover();

/* sync indicator */
function setSync(ok){
  $("#syncDot").className="sync-dot "+(ok?"online":"offline");
  $("#syncText").textContent = ok ? "LIVE — SYNCED" : "OFFLINE";
}
