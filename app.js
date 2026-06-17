/* =====================================================================
   TrackAbility — application logic
   Firestore (shared, live sync) + EmailJS (nudges)
   Data model:
     people (collection)
       <personId> { name, email, createdAt }
         days (subcollection)
           <YYYY-MM-DD> { date, note, tasks:[{id,text,status}], updatedAt }
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  serverTimestamp, query, orderBy
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
const todayStr = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const initials = n => (n||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
const uid = () => "t" + Math.random().toString(36).slice(2,9) + (performance.now()|0).toString(36);
function fmtDate(s){
  const [y,m,d]=s.split("-").map(Number);
  const dt=new Date(y,m-1,d);
  return dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric"});
}
let toastT;
function toast(msg, isErr=false){
  const t=$("#toast"); t.textContent=msg; t.className="toast"+(isErr?" err":"");
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add("hidden"),3200);
}

/* =====================================================================
   PEOPLE  (live)
   ===================================================================== */
onSnapshot(collection(db,"people"),
  snap => {
    state.people = snap.docs.map(d=>({id:d.id, ...d.data()}))
                       .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
    // ensure a days listener exists for each person (for "behind" flags)
    state.people.forEach(p => subscribeDays(p.id));
    renderPeople();
    setSync(true);
  },
  err => { console.error(err); setSync(false); toast("Sync error — check Firestore rules.", true); }
);

function subscribeDays(personId){
  if (state.dayUnsubs[personId]) return;
  const q = query(collection(db,"people",personId,"days"), orderBy("date","desc"));
  state.dayUnsubs[personId] = onSnapshot(q, snap=>{
    state.daysByPerson[personId] = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderPeople();
    if (state.selPerson===personId) {/* date list re-renders via renderPeople */}
  });
}

/* =====================================================================
   RENDER: sidebar tree
   ===================================================================== */
function renderPeople(){
  const wrap=$("#peopleList");
  if(!state.people.length){
    wrap.innerHTML=`<div class="date-empty">No operatives yet. Hit + to deploy one.</div>`;
    return;
  }
  wrap.innerHTML = state.people.map(p=>{
    const open = state.selPerson===p.id;
    const days = state.daysByPerson[p.id]||[];
    const behind = isBehind(p.id);
    const flag = behind
      ? `<span class="person-flag behind">BEHIND</span>`
      : (days.length ? `<span class="person-flag ok">ON TRACK</span>` : "");
    const dateRows = open ? renderDates(p.id, days) : "";
    const tools = open ? `
      <div class="person-tools">
        <button class="tool-btn" data-act="addday" data-p="${p.id}">+ ADD DATE</button>
        <button class="tool-btn nudge" data-act="nudge" data-p="${p.id}">▲ NUDGE</button>
      </div>` : "";
    return `
      <div class="person ${open?"open":""}" data-p="${p.id}">
        <div class="person-row" data-act="toggle" data-p="${p.id}">
          <span class="person-caret">▶</span>
          <span class="person-badge">${esc(initials(p.name))}</span>
          <span class="person-name">${esc(p.name)}</span>
          ${flag}
        </div>
        ${tools}
        ${dateRows}
      </div>`;
  }).join("");
}

function renderDates(personId, days){
  const inner = days.length
    ? days.map(d=>{
        const tasks=d.tasks||[];
        const done=tasks.filter(t=>t.status==="done").length;
        const active = state.selPerson===personId && state.selDate===d.id;
        return `<div class="date-item ${active?"active":""}" data-act="openday" data-p="${personId}" data-d="${d.id}">
                  <span>${esc(fmtDate(d.id))}</span>
                  <span class="di-prog">${done}/${tasks.length}</span>
                </div>`;
      }).join("")
    : `<div class="date-empty">No dates logged.</div>`;
  return `<div class="date-list">${inner}</div>`;
}

// "behind" = no entry for today, OR today's entry has tasks but none complete
function isBehind(personId){
  const days = state.daysByPerson[personId];
  if(!days) return false;
  const today = days.find(d=>d.id===todayStr());
  if(!today) return true;
  const tasks = today.tasks||[];
  if(!tasks.length) return true;
  return !tasks.some(t=>t.status==="done");
}

/* sidebar click delegation */
$("#peopleList").addEventListener("click", e=>{
  const el = e.target.closest("[data-act]"); if(!el) return;
  const act=el.dataset.act, pid=el.dataset.p;
  if(act==="toggle"){
    state.selPerson = state.selPerson===pid ? null : pid;
    if(state.selPerson!==pid) {/* keep selDate */}
    renderPeople();
  } else if(act==="addday"){
    addDay(pid);
  } else if(act==="nudge"){
    openNudge(pid);
  } else if(act==="openday"){
    openDay(pid, el.dataset.d);
  }
});

/* =====================================================================
   WRITES
   ===================================================================== */
async function addPerson(name, email){
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || uid();
  await setDoc(doc(db,"people",id), { name, email:email||"", createdAt:serverTimestamp() });
  state.selPerson=id; toast(`Operative "${name}" deployed.`);
}

async function addDay(personId, date){
  const d = date || todayStr();
  const ref = doc(db,"people",personId,"days",d);
  const existing = (state.daysByPerson[personId]||[]).find(x=>x.id===d);
  if(!existing){
    await setDoc(ref,{ date:d, note:"", tasks:[], updatedAt:serverTimestamp() });
  }
  state.selPerson=personId;
  openDay(personId, d);
}

async function persistDay(){
  if(!state.selPerson||!state.selDate||!state.curDay) return;
  const ref=doc(db,"people",state.selPerson,"days",state.selDate);
  await setDoc(ref,{
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

  const ref=doc(db,"people",personId,"days",date);
  state.daySub = onSnapshot(ref, snap=>{
    state.curDay = snap.exists() ? snap.data() : { date, note:"", tasks:[] };
    renderDay();
    renderPeople(); // refresh active highlight + counts
  });
}

function renderDay(){
  const person = state.people.find(p=>p.id===state.selPerson);
  $("#crumbPerson").textContent = person ? person.name : "—";
  $("#crumbDate").textContent = state.selDate || "—";
  $("#dayTitle").textContent = state.selDate ? fmtDate(state.selDate).toUpperCase() : "DAILY LOG";

  // note (don't clobber while user is typing)
  const noteEl=$("#noteArea");
  if(document.activeElement!==noteEl) noteEl.value = state.curDay.note||"";

  if(state.view==="list") renderList(); else renderKanban();
}

function renderList(){
  $("#listView").classList.remove("hidden");
  $("#kanbanView").classList.add("hidden");
  const tasks=state.curDay.tasks||[];
  const wrap=$("#listView");
  if(!tasks.length){ wrap.innerHTML=`<div class="empty-tasks">No objectives logged for this day. Add one above.</div>`; return; }
  const order={todo:0,doing:1,done:2};
  wrap.innerHTML = [...tasks].sort((a,b)=>(order[a.status]||0)-(order[b.status]||0)).map(t=>`
    <div class="task" data-status="${t.status}" data-id="${t.id}">
      <div class="check" data-act="check">✓</div>
      <div class="task-text">${esc(t.text)}</div>
      <button class="status-pill" data-act="cycle">${(t.status||"todo").toUpperCase()}</button>
      <button class="task-del" data-act="del" title="Remove">×</button>
    </div>`).join("");
}

function renderKanban(){
  $("#listView").classList.add("hidden");
  $("#kanbanView").classList.remove("hidden");
  const tasks=state.curDay.tasks||[];
  ["todo","doing","done"].forEach(stat=>{
    const body=$(`.kan-body[data-drop="${stat}"]`);
    const col=tasks.filter(t=>(t.status||"todo")===stat);
    $(`.kan-col[data-status="${stat}"] [data-count]`).textContent=col.length;
    body.innerHTML = col.map(t=>`
      <div class="kan-card" draggable="true" data-id="${t.id}">
        ${esc(t.text)}
        <button class="kc-del" data-act="del" data-id="${t.id}" title="Remove">×</button>
      </div>`).join("");
  });
}

/* task mutations (operate on local copy then persist; snapshot re-renders) */
function setTasks(fn){
  state.curDay.tasks = fn([...(state.curDay.tasks||[])]);
  persistDay();
}
function addTask(text){
  if(!text.trim()) return;
  setTasks(ts=>[...ts,{id:uid(),text:text.trim(),status:"todo"}]);
}
function delTask(id){ setTasks(ts=>ts.filter(t=>t.id!==id)); }
function setStatus(id,status){ setTasks(ts=>ts.map(t=>t.id===id?{...t,status}:t)); }
function cycleStatus(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  const next={todo:"doing",doing:"done",done:"todo"}[cur?.status||"todo"];
  setStatus(id,next);
}
function toggleDone(id){
  const cur=(state.curDay.tasks||[]).find(t=>t.id===id);
  setStatus(id, cur?.status==="done" ? "todo" : "done");
}

/* list interactions */
$("#listView").addEventListener("click", e=>{
  const el=e.target.closest("[data-act]"); if(!el) return;
  const id=el.closest(".task")?.dataset.id; if(!id) return;
  if(el.dataset.act==="check") toggleDone(id);
  else if(el.dataset.act==="cycle") cycleStatus(id);
  else if(el.dataset.act==="del") delTask(id);
});

/* kanban interactions: delete + drag/drop */
$("#kanbanView").addEventListener("click", e=>{
  const del=e.target.closest('[data-act="del"]'); if(del) delTask(del.dataset.id);
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
$$(".kan-body").forEach(body=>{
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

/* note autosave (debounced) */
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

/* nudge */
const nudgeModal=$("#nudgeModal"); let nudgeTarget=null;
function openNudge(personId){
  const p=state.people.find(x=>x.id===personId); if(!p) return;
  if(!p.email){ toast(`${p.name} has no email on file.`, true); return; }
  nudgeTarget=p;
  const behind=isBehind(personId);
  $("#nudgeSummary").innerHTML = behind
    ? `<b>${esc(p.name)}</b> looks <b>behind</b> on today's log. Fire off a friendly nudge to <b>${esc(p.email)}</b>.`
    : `Send an accountability ping to <b>${esc(p.name)}</b> at <b>${esc(p.email)}</b>.`;
  $("#nudgeMsg").value = `Hey ${p.name}, just checking in — don't forget to log your accountability tracker today. Let's keep the streak going! 💪`;
  nudgeModal.classList.remove("hidden");
}
$("#nudgeCancel").addEventListener("click", ()=>nudgeModal.classList.add("hidden"));
$("#nudgeSend").addEventListener("click", async ()=>{
  if(!nudgeTarget) return;
  if(!emailReady){ toast("EmailJS not configured yet (need Service ID + Template ID).", true); return; }
  const btn=$("#nudgeSend"); btn.disabled=true; btn.textContent="SENDING…";
  try{
    await emailjs.send(CFG.emailjs.serviceId, CFG.emailjs.templateId, {
      to_email: nudgeTarget.email,
      to_name:  nudgeTarget.name,
      from_name: CFG.myName||"A friend",
      message: $("#nudgeMsg").value,
      days_behind: isBehind(nudgeTarget.id) ? "behind" : "on track"
    });
    toast(`Nudge sent to ${nudgeTarget.name}.`);
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
const isMobile = () => window.matchMedia("(max-width:760px)").matches;
function setNav(collapsed, remember=true){
  document.body.classList.toggle("nav-collapsed", collapsed);
  if(remember && !isMobile()) localStorage.setItem("ta_nav_collapsed", collapsed ? "1" : "0");
}
// initial state: phones start collapsed (content first); desktop restores last choice
setNav(isMobile() ? true : localStorage.getItem("ta_nav_collapsed")==="1", false);

$("#navCollapse").addEventListener("click", ()=>setNav(true));
$("#navReopen").addEventListener("click", ()=>setNav(false));
$("#navBackdrop").addEventListener("click", ()=>setNav(true));
// on mobile, picking a day should close the drawer so the log is visible
function maybeCloseDrawer(){ if(isMobile()) setNav(true, false); }

/* sync indicator */
function setSync(ok){
  $("#syncDot").className="sync-dot "+(ok?"online":"offline");
  $("#syncText").textContent = ok ? "LIVE — SYNCED" : "OFFLINE";
}
