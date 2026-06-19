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
  serverTimestamp, query, orderBy, getDocs, writeBatch
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

/* ---------- state ---------- */
const state = {
  people: [],                 // [{id,name,email}]
  daysByPerson: {},           // personId -> [{id(date), tasks, note}]
  dayUnsubs: {},              // personId -> unsubscribe fn for its days
  daySub: null,               // active single-day listener
  selPerson: null,            // personId
  selDate: null,              // 'YYYY-MM-DD'
  curDay: null,               // active day doc data
  view: "list"
};

/* ---------- helpers ---------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => (s??"").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const initials = n => (n||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
const uid = () => "t" + Math.random().toString(36).slice(2,9) + (performance.now()|0).toString(36);
// Which bucket a task lives in. Carried-over tasks sit in "backlog" until done,
// at which point completion clears the flag and they move to the normal "done" bucket.
const taskBucket = t => (t.backlog && t.status!=="done") ? "backlog" : (t.status||"todo");

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
    const sel = state.selPerson===p.id;
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
    $("#dayView").classList.add("hidden");
    $("#welcome").classList.remove("hidden");
    renderDateList();
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
    .filter(t => t.status !== "done")
    .map(t => ({ id: uid(), text: t.text, status: "todo", backlog: true }));
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
  await setDoc(doc(db,"people",state.selPerson,"days",state.selDate),{
    date: state.selDate,
    note: state.curDay.note||"",
    tasks: state.curDay.tasks||[],
    updatedAt: serverTimestamp()
  });
}

/* =====================================================================
   DAY VIEW
   ===================================================================== */
function openDay(personId, date){
  state.selPerson=personId; state.selDate=date;
  maybeCloseDrawer();
  if(state.daySub){ state.daySub(); state.daySub=null; }
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

function taskRow(t){
  if(taskBucket(t)==="backlog"){
    // Carried-over: locked to the backlog bucket. Can be completed or removed,
    // but not dragged or reclassified into today's working buckets.
    return `<div class="task backlog" data-status="${t.status}" data-id="${t.id}">
      <span class="task-grip locked" title="Carried over — locked to backlog" aria-hidden="true">⟳</span>
      <div class="check" data-act="check">✓</div>
      <div class="task-text">${esc(t.text)}</div>
      <span class="status-pill is-backlog" title="Carried over from a previous day">BACKLOG</span>
      <button class="task-del" data-act="del" title="Remove">×</button>
    </div>`;
  }
  return `<div class="task" draggable="true" data-status="${t.status}" data-id="${t.id}">
      <span class="task-grip" title="Drag to reorder" aria-hidden="true">⠿</span>
      <div class="check" data-act="check">✓</div>
      <div class="task-text">${esc(t.text)}</div>
      <button class="status-pill" data-act="cycle">${(t.status||"todo").toUpperCase()}</button>
      <button class="task-del" data-act="del" title="Remove">×</button>
    </div>`;
}

function renderList(){
  $("#listView").classList.remove("hidden");
  $("#kanbanView").classList.add("hidden");
  const tasks=state.curDay.tasks||[];
  const wrap=$("#listView");
  if(!tasks.length){ wrap.innerHTML=`<div class="empty-tasks">No objectives logged for this day. Add one above.</div>`; return; }
  const backlog = tasks.filter(t=>taskBucket(t)==="backlog");
  const active  = tasks.filter(t=>taskBucket(t)!=="backlog");   // rendered in stored order (drag-reorderable)
  let html="";
  if(backlog.length){
    html += `<div class="list-group-label backlog">⟳ BACKLOG — carried over, clear it or it rolls again</div>`;
    html += backlog.map(taskRow).join("");
    if(active.length) html += `<div class="list-group-label">TODAY</div>`;
  }
  html += active.map(taskRow).join("");
  wrap.innerHTML = html;
}

function renderKanban(){
  $("#listView").classList.add("hidden");
  $("#kanbanView").classList.remove("hidden");
  const tasks=state.curDay.tasks||[];

  // Backlog column — locked cards: complete (✓) or remove only, never dragged out.
  const backlog=tasks.filter(t=>taskBucket(t)==="backlog");
  const bbody=$('.kan-body[data-bucket="backlog"]');
  $('.kan-col[data-status="backlog"] [data-count]').textContent=backlog.length;
  bbody.innerHTML = backlog.map(t=>`
    <div class="kan-card backlog" data-id="${t.id}">
      ${esc(t.text)}
      <button class="kc-check" data-act="check" data-id="${t.id}" title="Mark complete">✓</button>
      <button class="kc-del" data-act="del" data-id="${t.id}" title="Remove">×</button>
    </div>`).join("");

  ["todo","doing","done"].forEach(stat=>{
    const body=$(`.kan-body[data-drop="${stat}"]`);
    const col=tasks.filter(t=>taskBucket(t)===stat);
    $(`.kan-col[data-status="${stat}"] [data-count]`).textContent=col.length;
    body.innerHTML = col.map(t=>`
      <div class="kan-card" draggable="true" data-id="${t.id}">
        ${esc(t.text)}
        <button class="kc-del" data-act="del" data-id="${t.id}" title="Remove">×</button>
      </div>`).join("");
  });
}

/* task mutations */
function setTasks(fn){ state.curDay.tasks = fn([...(state.curDay.tasks||[])]); persistDay(); }
function addTask(text){ if(!text.trim()) return; setTasks(ts=>[...ts,{id:uid(),text:text.trim(),status:"todo"}]); }
function delTask(id){ setTasks(ts=>ts.filter(t=>t.id!==id)); }
function setStatus(id,status){ setTasks(ts=>ts.map(t=>t.id===id?{...t,status}:t)); }
function cycleStatus(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  if(cur?.backlog && cur.status!=="done") return;   // backlog tasks are locked out of the working buckets
  setStatus(id, {todo:"doing",doing:"done",done:"todo"}[cur?.status||"todo"]);
}
function toggleDone(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  const done = cur?.status==="done";
  // Completing a backlog task clears its flag so it moves into the COMPLETE bucket.
  setTasks(ts=>ts.map(t=>t.id===id ? {...t, status: done?"todo":"done", backlog:false} : t));
}

/* list interactions */
$("#listView").addEventListener("click", e=>{
  const el=e.target.closest("[data-act]"); if(!el) return;
  const id=el.closest(".task")?.dataset.id; if(!id) return;
  if(el.dataset.act==="check") toggleDone(id);
  else if(el.dataset.act==="cycle") cycleStatus(id);
  else if(el.dataset.act==="del") delTask(id);
});

/* list drag-to-reorder — rewrites the stored sequence of the active (non-backlog) tasks */
function reorderActiveByIds(ids){
  setTasks(ts=>{
    const backlog=ts.filter(t=>taskBucket(t)==="backlog");
    const byId=new Map(ts.map(t=>[t.id,t]));
    const active=ids.map(id=>byId.get(id)).filter(t=>t && taskBucket(t)!=="backlog");
    ts.forEach(t=>{ if(taskBucket(t)!=="backlog" && !ids.includes(t.id)) active.push(t); }); // safety
    return [...backlog, ...active];
  });
}
function dragAfterTask(container, y){
  const els=[...container.querySelectorAll(".task:not(.dragging):not(.backlog)")];
  return els.reduce((closest, el)=>{
    const box=el.getBoundingClientRect();
    const offset=y - box.top - box.height/2;
    return (offset<0 && offset>closest.offset) ? {offset, el} : closest;
  }, {offset:Number.NEGATIVE_INFINITY, el:null}).el;
}
let listDragId=null;
$("#listView").addEventListener("dragstart", e=>{
  const t=e.target.closest(".task"); if(!t || t.classList.contains("backlog")) return;
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
  const ids=$$("#listView .task:not(.backlog)").map(el=>el.dataset.id);
  listDragId=null;
  reorderActiveByIds(ids); // persists; live snapshot re-renders the canonical order
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
  const card=e.target.closest(".kan-card"); if(!card || card.classList.contains("backlog")) return;
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

/* nudge — targets the currently open operative */
const nudgeModal=$("#nudgeModal");
$("#nudgeBtn").addEventListener("click", ()=>{ if(state.selPerson) openNudge(state.selPerson); });
function openNudge(personId){
  const p=state.people.find(x=>x.id===personId); if(!p) return;
  if(!p.email){ toast(`${p.name} has no email on file.`, true); return; }
  const behind=isBehind(personId);
  $("#nudgeSummary").innerHTML = behind
    ? `<b>${esc(p.name)}</b> looks <b>behind</b> on today's log. Fire off a friendly nudge to <b>${esc(p.email)}</b>.`
    : `Send an accountability ping to <b>${esc(p.name)}</b> at <b>${esc(p.email)}</b>.`;
  $("#nudgeMsg").value = `Hey ${p.name}, just checking in — don't forget to log your accountability tracker today. Let's keep the streak going! 💪`;
  nudgeModal.dataset.target=personId;
  nudgeModal.classList.remove("hidden");
}
$("#nudgeCancel").addEventListener("click", ()=>nudgeModal.classList.add("hidden"));
$("#nudgeSend").addEventListener("click", async ()=>{
  const p=state.people.find(x=>x.id===nudgeModal.dataset.target); if(!p) return;
  if(!emailReady){ toast("EmailJS not configured yet (need Service ID).", true); return; }
  const btn=$("#nudgeSend"); btn.disabled=true; btn.textContent="SENDING…";
  // Send the address under several common variable names so it maps no matter
  // which one the EmailJS template's "To Email" field references.
  const params = {
    to_email: p.email, email: p.email, user_email: p.email, recipient: p.email, to: p.email, reply_to: p.email,
    to_name: p.name, name: p.name,
    from_name: CFG.myName||"A friend",
    message: $("#nudgeMsg").value,
    days_behind: isBehind(p.id) ? "behind" : "on track"
  };
  try{
    await emailjs.send(CFG.emailjs.serviceId, CFG.emailjs.templateId, params);
    toast(`Nudge sent to ${p.name}.`);
    nudgeModal.classList.add("hidden");
  }catch(e){
    console.error("EmailJS error:", e);
    const detail = (e && (e.text || e.message)) ? `${e.status||""} ${e.text||e.message}`.trim() : "unknown error";
    toast(`Email failed: ${detail}`, true);
  }
  finally{ btn.disabled=false; btn.textContent="▸ SEND NUDGE"; }
});

/* close modals on backdrop click / Esc */
[personModal,nudgeModal].forEach(m=>m.addEventListener("click", e=>{ if(e.target===m) m.classList.add("hidden"); }));
document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ personModal.classList.add("hidden"); nudgeModal.classList.add("hidden"); }});

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
