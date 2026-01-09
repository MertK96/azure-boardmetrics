window.assignableItems = window.assignableItems || [];
var assignableItems = window.assignableItems;

const $ = (id) => document.getElementById(id);

let currentId = null;
let currentDetailDescHtml = '';
let azdoCfg = null;

let activeView = 'board'; // 'board' | 'review' | 'assign' | 'perf'
let assignAutoTimer = null;

let assignItems = [];
let assignLoaded = false;
let assignColumnSort = { 0: 'default', 1: 'default', 2: 'default', 3: 'default', 4: 'default' };

let perfLoaded = false;
let perfInitDone = false;
let perfActiveUser = null;
let perfSummary = [];
let perfCandles = [];
let perfDoneItems = [];
let perfDoneById = new Map();
let perfDailyStacks = [];
let azdoUsersLoaded = false;
let azdoUsers = [];

let activeTab = 'note'; // 'note' | 'comment'

function pad2(n){ return String(n).padStart(2,'0'); }

function n2(v){
  const x = Math.round((Number(v) || 0) * 100) / 100;
  return x.toFixed(2).replace(/\.00$/, '');
}

function ymdLocal(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function todayKey(){
  return ymdLocal(new Date());
}


function setView(view){
  activeView = view;

  const btnBoard = $('viewTab_board');
  const btnReview = $('viewTab_review');
  const btnAssign = $('viewTab_assign');
  const btnPerf = $('viewTab_perf');

  const viewBoard = $('view_board');
  const viewReview = $('view_review');
  const viewAssign = $('view_assign');
  const viewPerf = $('view_perf');

  if(btnBoard) btnBoard.classList.toggle('active', view === 'board');
  if(btnReview) btnReview.classList.toggle('active', view === 'review');
  if(btnAssign) btnAssign.classList.toggle('active', view === 'assign');
  if(btnPerf) btnPerf.classList.toggle('active', view === 'perf');

  if(viewBoard) viewBoard.classList.toggle('hidden', view !== 'board');
  if(viewReview) viewReview.classList.toggle('hidden', view !== 'review');
  if(viewAssign) viewAssign.classList.toggle('hidden', view !== 'assign');
  if(viewPerf) viewPerf.classList.toggle('hidden', view !== 'perf');

  if(view === 'review'){
    ensureAzdoUsers().then(loadReviewItems);
  }

  if(view === 'assign'){
    ensureConfig()
      .then(() => ensureAzdoUsers())
      .then(() => {
        if(!assignLoaded) loadAssignableItems();
        else renderAssignable();
      });

    // auto-refresh every 60s while on this tab
    if(assignAutoTimer) clearInterval(assignAutoTimer);
    assignAutoTimer = setInterval(() => {
      if(activeView === 'assign') loadAssignableItems();
    }, 60000);
  }

  // leaving assign => stop timer
  if(view !== 'assign' && assignAutoTimer){
    clearInterval(assignAutoTimer);
    assignAutoTimer = null;
  }

  if(view === 'perf'){
    ensureConfig().then(() => ensureAzdoUsers()).then(() => {
      initPerfView();
      loadPerf();
    });
  }
}

async function ensureAzdoUsers(){
  if(azdoUsersLoaded) return;

  try{
    const res = await fetch('/api/azdo/users?top=500');
    if(res.ok) azdoUsers = await res.json();
  }catch(_){}


  // fallback: graph users boş dönerse config'teki users listesini kullan
  if(!azdoUsers || !Array.isArray(azdoUsers) || azdoUsers.length === 0){
    try{
      const r2 = await fetch('/api/assignees');
      if(r2.ok){
        const arr = await r2.json();
        azdoUsers = (arr || []).map(x => ({ displayName: String(x||'').trim(), uniqueName: String(x||'').trim() }));
      }
    }catch(_){ }
  }

  azdoUsers = (azdoUsers || [])
    .filter(x => x && (x.uniqueName || x.displayName))
    .map(x => ({
      displayName: (x.displayName || '').trim(),
      uniqueName: (x.uniqueName || '').trim()
    }));

  azdoUsers.sort((a,b) => {
    const aa = (a.displayName || a.uniqueName || '');
    const bb = (b.displayName || b.uniqueName || '');
    return aa.localeCompare(bb, 'tr');
  });

  azdoUsersLoaded = true;
}
async function ensureConfig(){
  if(azdoCfg) return azdoCfg;
  try{
    const res = await fetch('/api/config');
    if(!res.ok) return (azdoCfg = {});
    azdoCfg = await res.json();
    return azdoCfg;
  }catch{
    return (azdoCfg = {});
  }
}

function buildBoardUrl(workItemId){
  // İstenen format:
  // https://dev.azure.com/Adisyo/adisyo-mill/_boards/board/t/Platform%20Team/Backlog%20items?workitem=17631

  const orgUrlRaw = (azdoCfg?.organizationUrl || '').trim();
  const projectRaw = (azdoCfg?.project || '').trim();
  const teamRaw = (azdoCfg?.team || '').trim();

  const orgUrl = (orgUrlRaw || 'https://dev.azure.com/Adisyo').replace(/\/+$/,'');
  const project = projectRaw || 'adisyo-mill';
  const team = teamRaw || 'Platform Team';

  const projSeg = encodeURIComponent(project);
  const teamSeg = encodeURIComponent(team);

  return `${orgUrl}/${projSeg}/_boards/board/t/${teamSeg}/Backlog%20items?workitem=${encodeURIComponent(String(workItemId))}`;
}

function fmtDate(s){
  if(!s) return '';
  try{
    const d = new Date(s);
    return ymdLocal(d);
  }catch{ return '';}
}

function dateKey(s){
  const d = fmtDate(s);
  return d || '';
}

function cell(txt, cls){
  const td = document.createElement('td');
  if(cls) td.className = cls;
  td.textContent = txt ?? '';
  return td;
}

function idCell(wi){
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.href = buildBoardUrl(wi.id);
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = String(wi.id);
  td.appendChild(a);
  return td;
}

function titleCell(wi){
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = wi.title ?? '';
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    await openDetail(wi.id);
  });
  td.appendChild(a);
  return td;
}

/**
 * Forecast vs Due mismatch (risk/early)
 * Not: Start+Effort+Due+ForecastDue varsa anlamlı.
 */
function forecastMismatchClass(wi){
  if(!wi.startDate) return '';
  if(wi.effort == null) return '';
  if(!wi.dueDate || !wi.forecastDueDate) return '';

  const due = dateKey(wi.dueDate);
  const fc = dateKey(wi.forecastDueDate);
  if(!due || !fc) return '';

  if(due === fc) return '';
  return (fc > due) ? 'late' : 'early';
}

/**
 * Due geçmiş mi? (commitment uyarısı)
 * İstek: Start→Due ayrı renk (pratikte Due <= Today olduğunda belirginleşir)
 */
function commitmentOverdue(wi){
  if(!wi.dueDate) return false;
  const due = dateKey(wi.dueDate);
  if(!due) return false;
  return due <= todayKey();
}

/**
 * ForecastDue geçmiş mi? (forecast uyarısı)
 * İstek: Start→ForecastDue ayrı renk (pratikte ForecastDue <= Today olduğunda belirginleşir)
 */
function forecastOverdue(wi){
  if(!wi.forecastDueDate) return false;
  const fc = dateKey(wi.forecastDueDate);
  if(!fc) return false;
  return fc <= todayKey();
}

// Description HTML'i güvenli şekilde text'e çevir
function htmlToText(html){
  if(!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html; // sadece textContent almak için
  return (tmp.textContent || tmp.innerText || '').trim();
}

// Description HTML'i göstermek için: img src'leri proxy'e çevir ve basit XSS temizliği yap
function rewriteDescriptionHtml(html){
  if(!html) return '';
  try{
    const doc = new DOMParser().parseFromString(String(html), 'text/html');

    // remove scripts
    doc.querySelectorAll('script').forEach(s => s.remove());

    // remove inline event handlers
    doc.body.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        const n = (a.name || '').toLowerCase();
        if(n.startsWith('on')) el.removeAttribute(a.name);
      });
    });

    // rewrite img src to backend proxy (PAT ile çekilsin)
    doc.body.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if(!src) return;
      if(/^https?:/i.test(src)) img.setAttribute('src', `/api/proxy/image?url=${encodeURIComponent(src)}`);
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });

    // make links safe
    doc.body.querySelectorAll('a').forEach(a => {
      a.setAttribute('target','_blank');
      a.setAttribute('rel','noreferrer');
    });

    return doc.body.innerHTML;
  }catch{
    return escapeHtml(String(html));
  }
}

// Rich description editor helpers
function _proxyImg(src){
  return `/api/proxy/image?url=${encodeURIComponent(src)}`;
}

function htmlToEditorDisplayHtml(html){
  if(!html) return '';
  try{
    const doc = new DOMParser().parseFromString(String(html), 'text/html');

    // remove scripts
    doc.querySelectorAll('script').forEach(s => s.remove());

    // remove inline event handlers
    doc.body.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        const n = (a.name || '').toLowerCase();
        if(n.startsWith('on')) el.removeAttribute(a.name);
      });
    });

    // rewrite imgs to proxy but keep original in data-src-original
    doc.body.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if(!src) return;
      if(img.getAttribute('data-src-original')) return;

      if(/^\/api\/proxy\/image\?url=/i.test(src)){
        try{
          const u = new URL(src, location.origin);
          const orig = u.searchParams.get('url');
          if(orig){
            img.setAttribute('data-src-original', orig);
            img.setAttribute('src', _proxyImg(orig));
          }
        }catch{}
      }else if(/^https?:/i.test(src)){
        img.setAttribute('data-src-original', src);
        img.setAttribute('src', _proxyImg(src));
      }

      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.style.display = 'block';
    });

    // make links safe
    doc.body.querySelectorAll('a').forEach(a => {
      a.setAttribute('target','_blank');
      a.setAttribute('rel','noreferrer');
    });

    return doc.body.innerHTML;
  }catch{
    return '';
  }
}

function editorDisplayToSaveHtml(displayHtml){
  const html = String(displayHtml || '');
  try{
    const doc = new DOMParser().parseFromString(`<div id="_r">${html}</div>`, 'text/html');
    const root = doc.getElementById('_r');
    if(!root) return html;

    root.querySelectorAll('img').forEach(img => {
      const orig = img.getAttribute('data-src-original');
      if(orig){
        img.setAttribute('src', orig);
        img.removeAttribute('data-src-original');
      }else{
        const src = img.getAttribute('src') || '';
        if(/^\/api\/proxy\/image\?url=/i.test(src)){
          try{
            const u = new URL(src, location.origin);
            const o = u.searchParams.get('url');
            if(o) img.setAttribute('src', o);
          }catch{}
        }
      }
      // keep size hints minimal
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });

    // remove any scripts just in case
    root.querySelectorAll('script').forEach(s => s.remove());
    root.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        const n = (a.name || '').toLowerCase();
        if(n.startsWith('on')) el.removeAttribute(a.name);
      });
    });

    return root.innerHTML;
  }catch{
    return html;
  }
}

async function uploadWorkItemImage(workItemId, file){
  const fd = new FormData();
  const name = (file && file.name) ? file.name : `pasted-${Date.now()}.png`;
  fd.append('file', file, name);
  const res = await fetch(`/api/workitems/${workItemId}/attachments`, { method:'POST', body: fd });
  if(!res.ok){
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  const j = await res.json();
  if(!j || !j.url) throw new Error('Attachment url alınamadı');
  return String(j.url);
}

function insertHtmlAtCaret(html){
  const sel = window.getSelection && window.getSelection();
  if(!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const el = document.createElement('div');
  el.innerHTML = html;
  const frag = document.createDocumentFragment();
  let node, lastNode;
  while((node = el.firstChild)){
    lastNode = frag.appendChild(node);
  }
  range.insertNode(frag);
  if(lastNode){
    const r = range.cloneRange();
    r.setStartAfter(lastNode);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

async function load(){
  await ensureConfig();
  $('status').textContent = 'yükleniyor...';

  // Azure'daki state değişikliklerinin anlık görünmesi için
  // board verisini çekmeden önce In Progress lane'ini Azure'dan tazeliyoruz.
  try{
    await fetch('/api/workitems/refresh-inprogress', { method:'POST' });
  }catch(e){
    // ignore
  }


  const assignee = $('assignee').value.trim();
  const mode = $('mode').value;

  const params = new URLSearchParams();
  if(assignee) params.set('assignee', assignee);
  if(mode === 'pool') params.set('flagged', 'pool');
  params.set('top', '400');

  let res;
  try{
    res = await fetch('/api/workitems?' + params.toString());
  }catch{
    $('status').textContent = 'API erişilemedi.';
    return;
  }

  if(!res.ok){
    $('status').textContent = `API hata: ${res.status}`;
    return;
  }

  const data = await res.json();

  const tbody = $('tbl').querySelector('tbody');
  tbody.innerHTML = '';

  for(const wi of data){
    const tr = document.createElement('tr');

    // Pool
    if(wi.needsFeedback) tr.classList.add('pool');

    // Forecast vs Due mismatch
    const mm = forecastMismatchClass(wi);
    if(mm) tr.classList.add(mm); // late / early

    // Due / ForecastDue geçmiş mi?
    const isCommitOver = commitmentOverdue(wi);
    if(isCommitOver) tr.classList.add('commitOver');

    const isFcOver = forecastOverdue(wi);
    if(isFcOver) tr.classList.add('forecastOver');

    tr.appendChild(idCell(wi));
    tr.appendChild(titleCell(wi));
    tr.appendChild(cell(wi.assignedToUniqueName ?? wi.assignedToDisplayName ?? ''));
    tr.appendChild(cell(wi.state));
    tr.appendChild(cell(wi.effort ?? ''));
    tr.appendChild(cell(fmtDate(wi.startDate)));

    // Due cell
    tr.appendChild(cell(fmtDate(wi.dueDate), isCommitOver ? 'cellCommitOver' : ''));

    tr.appendChild(cell(fmtDate(wi.doneDate)));
    tr.appendChild(cell(wi.expectedDays ?? ''));

    // ForecastDue cell
    tr.appendChild(cell(fmtDate(wi.forecastDueDate), isFcOver ? 'cellForecastOver' : ''));

    tr.appendChild(cell(wi.forecastVarianceDays ?? ''));
    tr.appendChild(cell(wi.slackDays ?? ''));
    tr.appendChild(cell(wi.needsFeedback ? (wi.poolReason ?? 'not var') : ''));

    tbody.appendChild(tr);
  }

  $('status').textContent = `ok (${data.length})`;
}

async function openDetail(id){
  currentId = id;

  await ensureConfig();

  $('detail').classList.remove('hidden');

  // default tab
  setActiveTab('note');
  const cmtStatus = $('cmt_status');
  if(cmtStatus) cmtStatus.textContent = '';
  $('d_title').textContent = `#${id}`;
  $('d_meta').textContent = 'yükleniyor...';
  const descEl = $('d_desc');
  if(descEl) descEl.textContent = 'yükleniyor...';

  let res;
  try{
    res = await fetch('/api/workitems/' + id);
  }catch{
    $('d_meta').textContent = 'Detay API erişilemedi.';
    if(descEl) descEl.textContent = '(açıklama yok)';
    return;
  }

  if(!res.ok){
    $('d_meta').textContent = `Detay API hata: ${res.status}`;
    if(descEl) descEl.textContent = '(açıklama yok)';
    return;
  }

  const data = await res.json();
  const wi = data.workItem;

  if(!wi){
    $('d_meta').textContent = 'Detay verisi boş döndü.';
    if(descEl) descEl.textContent = '(açıklama yok)';
    return;
  }

  $('d_title').textContent = `#${wi.id} - ${wi.title ?? ''}`;
  $('d_meta').textContent = [
    wi.assignedToUniqueName ?? wi.assignedToDisplayName ?? '',
    wi.state ?? '',
    `Effort:${wi.effort ?? ''}`,
    `ExpDays:${wi.expectedDays ?? ''}`,
    `Start:${fmtDate(wi.startDate)} Due:${fmtDate(wi.dueDate)} Forecast:${fmtDate(wi.forecastDueDate)} Done:${fmtDate(wi.doneDate)}`,
    `ForecastVar:${wi.forecastVarianceDays ?? ''} Slack:${wi.slackDays ?? ''}`,
    wi.poolReason ? `PoolReason:${wi.poolReason}` : ''
  ].filter(Boolean).join(' | ');

  $('d_url').href = buildBoardUrl(wi.id);

  renderList('fb_list', (data.feedback || []).map(f => `${fmtDate(f.createdAt)} - ${f.note}`));

  if(descEl){
    currentDetailDescHtml = data.descriptionHtml || '';

    const renderDesc = () => {
      if(!currentDetailDescHtml){
        descEl.textContent = '(açıklama yok)';
        return;
      }
      descEl.innerHTML = rewriteDescriptionHtml(currentDetailDescHtml);
    };

    renderDesc();

    // Make description editable from detail view (button + click on empty area)
    const openEdit = (e) => {
      if(e){ e.preventDefault(); e.stopPropagation(); }
      openEditDescriptionModalGeneric(wi.id, currentDetailDescHtml, (serverHtml)=>{
        // serverHtml could include preserved images
        currentDetailDescHtml = serverHtml || '';
        renderDesc();
      });
    };

    // Click inside description: if user clicked an image/link, don't open editor
    descEl.addEventListener('click', (e)=>{
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toUpperCase() : '';
      if(tag === 'A' || tag === 'IMG' || (t && t.closest && (t.closest('a') || t.closest('img')))) return;
      openEdit(e);
    });

    const btn = $('d_desc_edit');
    if(btn) btn.onclick = openEdit;
  }
}

function setActiveTab(tab){
  activeTab = tab;
  const btnNote = $('tab_note');
  const btnComment = $('tab_comment');
  const panelNote = $('panel_note');
  const panelComment = $('panel_comment');
  if(!btnNote || !btnComment || !panelNote || !panelComment) return;

  const isNote = tab === 'note';
  btnNote.classList.toggle('active', isNote);
  btnComment.classList.toggle('active', !isNote);
  btnNote.setAttribute('aria-selected', isNote ? 'true' : 'false');
  btnComment.setAttribute('aria-selected', isNote ? 'false' : 'true');
  panelNote.classList.toggle('hidden', !isNote);
  panelComment.classList.toggle('hidden', isNote);
}

function renderList(id, items){
  const el = $(id);
  el.innerHTML = '';
  if(!items || items.length === 0){
    el.textContent = '(boş)';
    return;
  }
  for(const t of items){
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = t;
    el.appendChild(div);
  }
}

async function sendFeedback(){
  if(!currentId) return;

  const payload = { note: $('fb_note').value.trim() };

  const res = await fetch(`/api/workitems/${currentId}/feedback`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });

  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    alert(err.message ?? 'Hata');
    return;
  }

  $('fb_note').value = '';
  await openDetail(currentId);
  await load();
}

async function sendComment(){
  if(!currentId) return;
  const txtEl = $('cmt_text');
  const statusEl = $('cmt_status');
  const btn = $('sendComment');
  if(!txtEl) return;

  const raw = txtEl.value.trim();
  if(!raw){
    if(statusEl) statusEl.textContent = 'Boş yorum gönderilemez.';
    return;
  }

  if(statusEl) statusEl.textContent = 'gönderiliyor...';
  if(btn) btn.disabled = true;

  // Server tarafında HTML'e sarıyoruz.
  const payload = { text: raw };

  let res;
  try{
    res = await fetch(`/api/workitems/${currentId}/comment`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
  }catch{
    if(statusEl) statusEl.textContent = 'API erişilemedi.';
    if(btn) btn.disabled = false;
    return;
  }

  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    const msg = err.message ?? err.error ?? `Hata (${res.status})`;
    if(statusEl) statusEl.textContent = msg;
    if(btn) btn.disabled = false;
    return;
  }

  txtEl.value = '';
  if(statusEl) statusEl.textContent = 'ok';
  if(btn) btn.disabled = false;
}

/* -------------------- Code Review Ataması -------------------- */


function extractNameFromIdentityText(text){
  if(!text) return '';
  const t = String(text).trim();
  const lt = t.indexOf('<');
  if(lt > 0) return t.slice(0, lt).trim();
  return t;
}

function extractEmailFromIdentityText(text){
  if(!text) return '';
  const t = String(text);
  const m = t.match(/<([^>]+)>/);
  if(m && m[1]) return m[1].trim();
  // if it's already an email-like string
  if(t.includes('@') && !t.includes(' ')) return t.trim();
  return '';
}

function renderReviewRow(wi){
  const tr = document.createElement('tr');

  // ID (stay in app)
  const tdId = document.createElement('td');
  const aId = document.createElement('a');
  aId.href = '#';
  aId.textContent = wi.id;
  aId.addEventListener('click', async (e) => {
    e.preventDefault();
    await openDetail(wi.id);
  });
  tdId.appendChild(aId);
  tr.appendChild(tdId);

  // Title (stay in app)
  const tdTitle = document.createElement('td');
  const aTitle = document.createElement('a');
  aTitle.href = '#';
  aTitle.textContent = wi.title ?? '';
  aTitle.addEventListener('click', async (e) => {
    e.preventDefault();
    await openDetail(wi.id);
  });
  tdTitle.appendChild(aTitle);
  tr.appendChild(tdTitle);

  const tdAss = document.createElement('td');
  tdAss.textContent = wi.assignedToDisplayName || wi.assignedToUniqueName || '';
  tr.appendChild(tdAss);

  // Current Review Owner (read-only)
  const tdOwner = document.createElement('td');
  const roName = (wi.reviewOwnerDisplayName || '').trim();
  const roMail = (wi.reviewOwnerUniqueName || '').trim();
  // UI: sadece isim göster (mail gizli). Name yoksa mail'i göster.
  tdOwner.textContent = extractNameFromIdentityText(roName || roMail || '');
  tr.appendChild(tdOwner);

  // Select new Review Owner (Azure users)
  const tdSelect = document.createElement('td');
  const sel = document.createElement('select');
  sel.className = 'reviewOwnerSelect';

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '-- seç --';
  sel.appendChild(empty);

  (azdoUsers || []).forEach(u => {
    const o = document.createElement('option');
    o.value = u.uniqueName || '';
    const label = (u.displayName && u.uniqueName)
      ? `${u.displayName} <${u.uniqueName}>`
      : (u.displayName || u.uniqueName || '');
    o.textContent = label;
    o.dataset.displayName = u.displayName || '';
    sel.appendChild(o);
  });

  // preselect current (try uniqueName first; if empty, parse from display text)
  const curUnique = (wi.reviewOwnerUniqueName || '').trim();
  const curFromText = extractEmailFromIdentityText(wi.reviewOwnerDisplayName || '');
  const cur = (curUnique || curFromText || '').trim().toLowerCase();
  if(cur){
    const opt = Array.from(sel.options).find(o => (o.value || '').trim().toLowerCase() === cur);
    if(opt) sel.value = opt.value;
  }

  tdSelect.appendChild(sel);
  tr.appendChild(tdSelect);

  const tdState = document.createElement('td');
  tdState.textContent = wi.state || '';
  tr.appendChild(tdState);

  const tdCol = document.createElement('td');
  tdCol.textContent = wi.boardColumn || '';
  tr.appendChild(tdCol);

  const tdAct = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'miniBtn';
  btn.textContent = 'Ata';
  btn.addEventListener('click', () => {
    const selected = sel.value || '';
    const selectedOpt = sel.options[sel.selectedIndex];
    const displayName = selectedOpt?.dataset?.displayName || '';
    assignReviewOwner(wi.id, selected, displayName);
  });
  tdAct.appendChild(btn);
  tr.appendChild(tdAct);

  return tr;
}

async function loadReviewItems(){
  await ensureAzdoUsers();

  const status = $('review_status');
  const tbody = $('tbl_review')?.querySelector('tbody');
  if(!tbody) return;

  const assignee = ($('review_assignee')?.value || '').trim();
  const q = new URLSearchParams();
  if(assignee) q.set('assignee', assignee);
  q.set('top', '500');

  if(status) status.textContent = 'yükleniyor...';

  let list = [];
  try{
    const res = await fetch('/api/code-review/items?' + q.toString());
    if(!res.ok){
      const err = await res.json().catch(() => null);
      if(status) status.textContent = err?.message || `hata: ${res.status}`;
      tbody.innerHTML = '';
      return;
    }
    list = await res.json();
  }catch(ex){
    if(status) status.textContent = ex?.message || 'hata';
    tbody.innerHTML = '';
    return;
  }

  tbody.innerHTML = '';
  (list || []).forEach(wi => tbody.appendChild(renderReviewRow(wi)));
  if(status) status.textContent = `${(list || []).length} madde`;
}

async function assignReviewOwner(id, reviewerUniqueName, reviewerDisplayName){
  const status = $('review_status');

  const uniqueName = (reviewerUniqueName || '').trim();
  const displayName = (reviewerDisplayName || '').trim();

  if(!uniqueName){
    if(status) status.textContent = 'Review Owner seçmelisin.';
    return;
  }

  if(status) status.textContent = `#${id} atanıyor...`;

  try{
    const res = await fetch(`/api/code-review/${id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewerUniqueName: uniqueName, reviewerDisplayName: displayName })
    });

    if(!res.ok){
      const err = await res.json().catch(() => null);
      if(status) status.textContent = err?.message || `hata: ${res.status}`;
      return;
    }

    if(status) status.textContent = `#${id} -> ${displayName || uniqueName} OK`;
    await loadReviewItems();
  }catch(ex){
    if(status) status.textContent = ex?.message || 'hata';
  }
}





let _assignDndInited = false;

function initAssignableDnd(){
  if(_assignDndInited) return;
  _assignDndInited = true;

  const cols = [
    { el: $('assign_col_story'), priority: 0, kind: 'story' },
    { el: $('assign_col_p1'), priority: 1, kind: 'p' },
    { el: $('assign_col_p2'), priority: 2, kind: 'p' },
    { el: $('assign_col_p3'), priority: 3, kind: 'p' },
    { el: $('assign_col_p4'), priority: 4, kind: 'p' }
  ].filter(x => x.el);

  function getDragAfterElement(container, y){
    const els = [...container.querySelectorAll('.aCard:not(.dragging)')];
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for(const child of els){
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if(offset < 0 && offset > closest.offset){
        closest = { offset, element: child };
      }
    }
    return closest.element;
  }

  for(const c of cols){
    c.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.aCard.dragging');
      if(!dragging) return;
      const after = getDragAfterElement(c.el, e.clientY);
      if(after == null) c.el.appendChild(dragging);
      else c.el.insertBefore(dragging, after);
    });

    c.el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      const targetP = c.priority;
      if(!id || !targetP) return;

      const card = document.querySelector(`.aCard[data-id="${id}"]`);

      // Determine if dragged item was from Stories column.
      // IMPORTANT: At 'drop' time, the DOM has already been updated, so we must use the source
      // column stored during dragstart (text/x-from-col).
      const fromCol = (() => { try{ return e.dataTransfer.getData('text/x-from-col') || ''; }catch{ return ''; } })();
      const fromStories = fromCol === 'assign_col_story';

      // Determine order neighbors in target column
      let beforeId = null, afterId = null;
      if(card){
        const prev = card.previousElementSibling;
        const next = card.nextElementSibling;
        if(prev && prev.classList.contains('aCard')) beforeId = Number(prev.dataset.id || 0) || null;
        if(next && next.classList.contains('aCard')) afterId = Number(next.dataset.id || 0) || null;
      }

      try{
        const res = await fetch(`/api/assignments/${id}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: targetP, makeApproved: fromStories, beforeId, afterId })
        });
        if(!res.ok){
          // 409: Revision mismatch is common in drag/drop bursts. If the move already applied
          // (duplicate handler, concurrent update), backend will often return 200; if it still
          // returns 409, just refresh silently.
          if(res.status === 409){
            await loadAssignableItems();
            return;
          }
          const tx = await res.text();
          throw new Error(`move failed: ${res.status} ${tx}`);
        }
        await loadAssignableItems();
      }catch(ex){
        alert(`Taşıma güncellenemedi: ${ex?.message || ex}`);
      }
    });
  }
}

// -------------------- Atanacak Maddeler --------------------
function parseAssigneeLabel(item){
  const dn = (item.assignedToDisplayName || '').trim();
  if(dn) return dn;
  const u = (item.assignedToUniqueName || '').trim();
  if(!u) return '';
  if(u.includes('@')) return u.split('@')[0];
  return u;
}

function getSelectedTags(){
  const box = $('assign_tags_list');
  if(!box) return [];
  const checks = box.querySelectorAll('input[type="checkbox"]');
  const tags = [];
  for(const c of checks){
    if(c.checked) tags.push(String(c.value));
  }
  return tags;
}

function getTagMode(){
  const checked = document.querySelector('input[name="assign_tag_mode"]:checked');
  return (checked?.value || 'or').toLowerCase();
}

function updateTagButton(){
  const btn = $('assign_tags_btn');
  if(!btn) return;
  const cnt = getSelectedTags().length;
  btn.textContent = cnt > 0 ? `Tags (${cnt})` : 'Tags';
}

function itemHasTag(item, tag){
  const tags = item.tags || item.Tags || [];
  if(!tags || !Array.isArray(tags)) return false;
  return tags.some(t => String(t).trim() === tag);
}

function itemPassTags(item, selectedTags, mode){
  if(!selectedTags || selectedTags.length === 0) return true;
  const m = (mode || 'or').toLowerCase();
  if(m === 'and'){
    for(const t of selectedTags){
      if(!itemHasTag(item, t)) return false;
    }
    return true;
  }
  // OR default
  for(const t of selectedTags){
    if(itemHasTag(item, t)) return true;
  }
  return false;
}

function itemPassType(item, sel){
  const s = (sel || '').trim().toLowerCase();
  if(!s) return true;
  const t = String(item.workItemType || '').trim().toLowerCase();
  if(s === 'bug') return t === 'bug';
  if(s === 'backlog') return t === 'product backlog item';
  return true;
}

function itemPassAssignee(item, sel){
  const s = (sel || '').trim();
  if(!s) return true;
  const u = (item.assignedToUniqueName || '').trim();
  if(s === '__unassigned__') return !u;
  return u && u.toLowerCase() === s.toLowerCase();
}

function cmpNum(a,b){ return (a??0) - (b??0); }

function sortByKey(arr, sortBy, order){
  const dir = (order === 'asc') ? 1 : -1;
  const key = (sortBy || 'changed').toLowerCase();

  const copy = arr.slice();
  copy.sort((x,y) => {
    let ax, ay;

    if(key === 'id'){
      ax = x.id; ay = y.id;
      if(ax !== ay) return (ax - ay) * dir;
    }else if(key === 'relevance'){
      ax = (x.relevance ?? Number.POSITIVE_INFINITY);
      ay = (y.relevance ?? Number.POSITIVE_INFINITY);
      if(ax !== ay) return (ax - ay) * dir;
    }else if(key === 'created'){
      ax = +new Date(x.createdDate);
      ay = +new Date(y.createdDate);
      if(ax !== ay) return (ax - ay) * dir;
    }else if(key === 'changed'){
      ax = +new Date(x.changedDate);
      ay = +new Date(y.changedDate);
      if(ax !== ay) return (ax - ay) * dir;
    }

    // stable tie-breaker: keep WIQL order
    return (x.orderIndex - y.orderIndex);
  });
  return copy;
}

function renderTagChips(tags){
  if(!tags || !Array.isArray(tags) || tags.length === 0) return '';
  const safe = tags.map(t => String(t).trim()).filter(Boolean);
  if(safe.length === 0) return '';
  return safe.map(t => `<span class="tagChip">${escapeHtml(t)}</span>`).join('');
}

function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');
}

function createAssignCard(item){
  const div = document.createElement('div');
  const typeRaw = (item.workItemType || '').trim();
  const type = typeRaw.toLowerCase();
  const cls = (type === 'bug') ? 'bug' : (type === 'product backlog item') ? 'backlog' : (type === 'user story') ? 'story' : '';

  const critical = isCriticalItem(item);
  const unassigned = isUnassignedItem(item);
  const overdueInProgress = isCriticalOverdueInProgress(item);

  const extraCls = [
    critical ? 'critical' : '',
    (critical && unassigned) ? 'criticalBlink' : '',
    overdueInProgress ? 'criticalOverdue' : ''
  ].filter(Boolean).join(' ');

  div.className = `aCard ${cls} ${extraCls}`.trim();

  div.dataset.id = String(item.id);
  div.draggable = true;
  div.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(item.id));
    // Preserve source column so we can decide approval correctly after the DOM move.
    const parentCol = div.closest('.kanBody')?.id || '';
    try{ e.dataTransfer.setData('text/x-from-col', parentCol); }catch{}
    e.dataTransfer.effectAllowed = 'move';
    div.classList.add('dragging');
  });
  div.addEventListener('dragend', () => {
    div.classList.remove('dragging');
  });

  // drag & drop support (assign view)
  div.draggable = true;
  div.dataset.id = String(item.id);
  div.dataset.workItemType = String(item.workItemType || '');


  const typeLabel = typeRaw;
  const title = (item.title || '').trim();
  const state = (item.state || '').trim();
  const assignee = parseAssigneeLabel(item);
  const tags = item.tags || [];

  div.innerHTML = `
    <div class="aTop">
      <a class="aId" href="${buildBoardUrl(item.id)}" target="_blank" rel="noreferrer">#${item.id}</a>
      <div class="aType">${escapeHtml(typeLabel)}</div>
    </div>

    <div class="aTitle">${escapeHtml(title)}</div>

    <div class="aMeta">
      <span class="aState">${escapeHtml(state)}</span>
      ${renderAssigneePicker(item)}
    </div>

    <div class="aDates">
      <span>Created: ${fmtDate(item.createdDate)}</span>
      <span>Changed: ${fmtDate(item.changedDate)}</span>
    </div>

    ${renderCriticalHint(item)}

    <div class="aTags">${renderTagChips(tags)}</div>
  `;

  
  // Inline assignee edit (bind after innerHTML)
  const picker = div.querySelector('.aAssigneePicker');
  if(picker){
    picker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAssigneeSelect(picker, item);
    });
  }

  // Title click -> existing detail screen works only for In Progress items; so keep it as link to ADO
  return div;
}


function renderAssigneePicker(item){
  const dn = parseAssigneeLabel(item);
  const label = dn ? dn : 'Unassigned';
  const muted = dn ? '' : ' muted';
  return `<button type="button" class="aAssigneePicker${muted}" data-wi="${item.id}" title="Atamayı değiştir">${escapeHtml(label)} <span class="caret">▾</span></button>`;
}

async function patchAssignee(workItemId, assigneeUniqueName){
  const res = await fetch(`/api/assignments/${workItemId}/assignee`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigneeUniqueName: assigneeUniqueName || '' })
  });

  if(!res.ok){
    const t = await res.text();
    throw new Error(t || (`HTTP ${res.status}`));
  }
}

function openAssigneeSelect(btn, item){
  // Replace button with a select for inline editing
  const sel = document.createElement('select');
  sel.className = 'aAssigneeSelect';

  // Build option list
  const optUn = document.createElement('option');
  optUn.value = '';
  optUn.textContent = 'Unassigned';
  sel.appendChild(optUn);

  const users = (azdoUsers || [])
    .map(u => ({
      displayName: String(u?.displayName || '').trim(),
      uniqueName: String(u?.uniqueName || '').trim()
    }))
    .filter(u => u.displayName || u.uniqueName)
    .sort((a,b) => (a.displayName || a.uniqueName).localeCompare((b.displayName || b.uniqueName), 'tr'));

  for(const u of users){
    const o = document.createElement('option');
    o.value = u.uniqueName || u.displayName;
    o.textContent = u.displayName || u.uniqueName;
    sel.appendChild(o);
  }

  // Determine current value
  const curUnique = String(item?.assignedToUniqueName || '').trim();
  const curDisplay = String(item?.assignedToDisplayName || '').trim();
  if(curUnique){
    sel.value = curUnique;
    if(sel.value !== curUnique){
      // Sometimes ADO returns "Name <mail>" etc; try contains match
      const match = Array.from(sel.options).find(o => String(o.value).toLowerCase() === curUnique.toLowerCase());
      if(match) sel.value = match.value;
    }
  }else if(curDisplay){
    const match = Array.from(sel.options).find(o => String(o.textContent||'').toLowerCase() === curDisplay.toLowerCase());
    if(match) sel.value = match.value;
  }else{
    sel.value = '';
  }

  // Swap
  btn.replaceWith(sel);
  sel.focus();

  let changed = false;

  sel.addEventListener('change', async () => {
    changed = true;
    const v = sel.value || '';
    sel.disabled = true;

    try{
      await patchAssignee(item.id, v);

      if(!v){
        item.assignedToUniqueName = null;
        item.assignedToDisplayName = null;
      }else{
        const found = users.find(x => (x.uniqueName || x.displayName) === v) || null;
        item.assignedToUniqueName = found?.uniqueName || v;
        item.assignedToDisplayName = found?.displayName || v;
      }

      // Re-render to update critical rules / filters
      renderAssignable();
    }catch(err){
      alert('Atama güncellenemedi: ' + (err?.message || err));
      renderAssignable();
    }
  });

  sel.addEventListener('blur', () => {
    if(changed) return;
    // restore button if user clicks away
    renderAssignable();
  });
}


function isCriticalItem(item){
  const title = String(item?.title || '').toLowerCase();
  const tags = (item?.tags || []).map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
  if(tags.some(t => t === 'critical' || t.includes('critical'))) return true;
  if(title.includes('critical')) return true;
  return false;
}

function isUnassignedItem(item){
  const dn = String(item?.assignedToDisplayName || '').trim();
  const un = String(item?.assignedToUniqueName || '').trim();
  return !(dn || un);
}

function isInProgressState(s){
  const x = String(s || '').trim().toLowerCase();
  if(!x) return false;
  // Common Agile processes + TR
  return x === 'active'
    || x.includes('in progress')
    || x.includes('progress')
    || x.includes('doing')
    || x.includes('devam')
    || x.includes('çalış')
    || x.includes('calis')
    || x.includes('geliştir')
    || x.includes('gelistir');
}

function isCriticalOverdueInProgress(item){
  if(!isCriticalItem(item)) return false;
  if(isUnassignedItem(item)) return false; // requirement: assigned + overdue in-progress
  if(!isInProgressState(item?.state)) return false;
  const dd = item?.dueDate ? new Date(item.dueDate) : null;
  if(!dd || isNaN(+dd)) return false;
  return dd.getTime() < Date.now();
}

function renderCriticalHint(item){
  if(!isCriticalItem(item)) return '';
  const unassigned = isUnassignedItem(item);
  const overdue = isCriticalOverdueInProgress(item);
  const dd = item?.dueDate ? fmtDate(item.dueDate) : '';

  let msg = '';
  if(unassigned){
    msg = 'CRITICAL • Unassigned';
  }else if(overdue){
    msg = `CRITICAL • Overdue (Due: ${dd || '-'})`;
  }else{
    msg = dd ? `CRITICAL • Due: ${dd}` : 'CRITICAL';
  }

  return `<div class="aCritical">${escapeHtml(msg)}</div>`;
}

function updateColumnSortButtons(){
  const cols = document.querySelectorAll('#assign_board .kanCol');
  for(const col of cols){
    const p = Number(col.getAttribute('data-priority') || '0');
    const mode = assignColumnSort[p] || 'default';
    const btns = col.querySelectorAll('.kanSortBtn');
    for(const b of btns){
      b.classList.toggle('active', (b.getAttribute('data-sort') || '') === mode);
    }
  }
}

function renderAssignable(){
  const status = $('assign_status');
  const storiesBox = $('assign_col_story');
  const col1 = $('assign_col_p1');
  const col2 = $('assign_col_p2');
  const col3 = $('assign_col_p3');
  const col4 = $('assign_col_p4');

  if(!storiesBox || !col1 || !col2 || !col3 || !col4) return;

  initAssignableDnd();

  const assSel = $('assign_assignee')?.value || '';
  const typeSel = $('assign_type')?.value || '';
  const sortBy = $('assign_sortBy')?.value || 'changed';
  const sortOrder = $('assign_sortOrder')?.value || 'desc';
  const tagMode = getTagMode();
  const selectedTags = getSelectedTags();

  const isNewState = (st) => {
    const s = String(st || '').trim().toLowerCase();
    return s === 'new' || s === 'yeni';
  };

  const filtered = (assignItems || []).filter(x => {
    return itemPassType(x, typeSel) && itemPassAssignee(x, assSel) && itemPassTags(x, selectedTags, tagMode);
  });

  // Stories lane = State: New (any type)
  const stories = filtered.filter(x => isNewState(x.state));
  // Priority columns = Approved Bug/PBI
  const others = filtered.filter(x => !isNewState(x.state));

  const sortedStories = sortByKey(stories, sortBy, sortOrder);
  const sortedOthers = sortByKey(others, sortBy, sortOrder);

  storiesBox.innerHTML = '';
  // story column has its own per-column override
  function applyColSort(arr, p){
    const mode = assignColumnSort[p] || 'default';
    if(mode === 'oldest'){
      const base = arr.slice().sort((a,b) => (+new Date(a.createdDate) - +new Date(b.createdDate)) || (a.orderIndex - b.orderIndex));
      return criticalFirst(base);
    }
    if(mode === 'newest'){
      const base = arr.slice().sort((a,b) => (+new Date(b.createdDate) - +new Date(a.createdDate)) || (a.orderIndex - b.orderIndex));
      return criticalFirst(base);
    }
    return criticalFirst(arr);
  }

  const storyItems = applyColSort(sortedStories, 0);
  for(const it of storyItems){
    storiesBox.appendChild(createAssignCard(it));
  }

  // group by priority
  const byP = {1: [], 2: [], 3: [], 4: []};
  for(const it of sortedOthers){
    const p = Number(it.priority || 0);
    if(byP[p]) byP[p].push(it);
  }

  const cols = {1: col1, 2: col2, 3: col3, 4: col4};
  for(const p of [1,2,3,4]){
    const box = cols[p];
    box.innerHTML = '';

    const items = applyColSort(byP[p] || [], p);

    // Stories should be on top if any ended up with priority info (rare). Keep requirement.
    const st = items.filter(x => String(x.workItemType || '').toLowerCase() === 'user story');
    const non = items.filter(x => String(x.workItemType || '').toLowerCase() !== 'user story');
    const finalArr = st.concat(non);

    for(const it of finalArr){
      box.appendChild(createAssignCard(it));
    }
  }

  updateColumnSortButtons();

  if(status){
    status.textContent = `Stories:${sortedStories.length} | Bug/PBI -> P1:${byP[1].length} P2:${byP[2].length} P3:${byP[3].length} P4:${byP[4].length}`;
  }

  updateTagButton();
}

function criticalFirst(arr){
  const crit = [];
  const rest = [];
  for(const x of (arr || [])){
    (isCriticalItem(x) ? crit : rest).push(x);
  }
  return crit.concat(rest);
}

function fillAssignFilters(items){
  // Assignees
  const sel = $('assign_assignee');
  if(sel){
    const current = sel.value || '';
    const map = new Map(); // uniqueName -> label
    for(const it of (items || [])){
      const u = (it.assignedToUniqueName || '').trim();
      const label = parseAssigneeLabel(it);
      if(u && label && !map.has(u)) map.set(u, label);
    }
    const arr = Array.from(map.entries()).map(([u,label]) => ({ u, label }));
    arr.sort((a,b) => (a.label || '').localeCompare((b.label || ''), 'tr'));

    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'Hepsi';
    sel.appendChild(optAll);

    const optUn = document.createElement('option');
    optUn.value = '__unassigned__';
    optUn.textContent = 'Unassigned';
    sel.appendChild(optUn);

    for(const x of arr){
      const o = document.createElement('option');
      o.value = x.u;
      o.textContent = x.label;
      sel.appendChild(o);
    }

    // restore if possible
    sel.value = current;
  }

  // Tags
  const box = $('assign_tags_list');
  if(box){
    const selected = new Set(getSelectedTags());
    const tags = new Set();
    for(const it of (items || [])){
      const t = it.tags || [];
      if(Array.isArray(t)){
        for(const tt of t){
          const v = String(tt || '').trim();
          if(v) tags.add(v);
        }
      }
    }
    const tagArr = Array.from(tags.values()).sort((a,b) => a.localeCompare(b,'tr'));
    box.innerHTML = '';
    for(const tag of tagArr){
      const id = `tag_${tag.replaceAll(/[^a-zA-Z0-9_-]/g,'_')}`;
      const wrap = document.createElement('label');
      wrap.className = 'tagItem';
      wrap.innerHTML = `<input type="checkbox" value="${escapeHtml(tag)}"> <span>${escapeHtml(tag)}</span>`;
      const input = wrap.querySelector('input');
      if(input && selected.has(tag)) input.checked = true;
      box.appendChild(wrap);
    }

    // change handler
    box.querySelectorAll('input[type="checkbox"]').forEach(ch => {
      ch.addEventListener('change', renderAssignable);
    });

    updateTagButton();
  }
}

async function loadAssignableItems(){
  const status = $('assign_status');
  if(status) status.textContent = 'yükleniyor...';

  let res;
  try{
    res = await fetch('/api/assignments/items?top=800');
  }catch{
    if(status) status.textContent = 'API erişilemedi.';
    return;
  }

  if(!res.ok){
    const err = await res.json().catch(() => null);
    if(status) status.textContent = err?.message || `API hata: ${res.status}`;
    return;
  }

  const data = await res.json();
  assignItems = Array.isArray(data) ? data : [];

  // normalize keys to camelCase (backend is already camel due to JSON settings? but be safe)
  assignItems = assignItems.map(x => ({
    orderIndex: x.orderIndex ?? x.OrderIndex ?? 0,
    id: x.id ?? x.Id,
    title: x.title ?? x.Title,
    workItemType: x.workItemType ?? x.WorkItemType,
    state: x.state ?? x.State,
    priority: x.priority ?? x.Priority,
    relevance: x.relevance ?? x.Relevance,
    assignedToDisplayName: x.assignedToDisplayName ?? x.AssignedToDisplayName,
    assignedToUniqueName: x.assignedToUniqueName ?? x.AssignedToUniqueName,
    createdDate: x.createdDate ?? x.CreatedDate,
    changedDate: x.changedDate ?? x.ChangedDate,
    dueDate: x.dueDate ?? x.DueDate,
    tags: x.tags ?? x.Tags ?? []
  }));

  fillAssignFilters(assignItems);
  renderAssignable();

  assignLoaded = true;
}

$('refresh').addEventListener('click', load);
$('close').addEventListener('click', () => $('detail').classList.add('hidden'));
$('sendFb').addEventListener('click', sendFeedback);

// view tabs
const boardBtn = $('viewTab_board');
const reviewBtn = $('viewTab_review');
const assignBtn = $('viewTab_assign');
if(boardBtn) boardBtn.addEventListener('click', () => setView('board'));
if(reviewBtn) reviewBtn.addEventListener('click', () => setView('review'));
if(assignBtn) assignBtn.addEventListener('click', () => setView('assign'));

const reviewRefreshBtn = $('review_refresh');
if(reviewRefreshBtn) reviewRefreshBtn.addEventListener('click', loadReviewItems);

// assign view
const assignRefreshBtn = $('assign_refresh');
if(assignRefreshBtn) assignRefreshBtn.addEventListener('click', loadAssignableItems);

// Inline new item (Azure-like)
const assignNewAddBtn = $('assign_new_add');
const assignNewTitle = $('assign_new_title');
if(assignNewAddBtn) assignNewAddBtn.addEventListener('click', createNewAssignItem);
if(assignNewTitle) assignNewTitle.addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){
    e.preventDefault();
    createNewAssignItem();
  }
});

const assignNewToggleBtn = $('assign_new_toggle');
const assignNewPanel = $('assign_new_panel');
if(assignNewToggleBtn && assignNewPanel){
  // start collapsed; open only on click
  assignNewPanel.classList.add('hidden');
  assignNewToggleBtn.addEventListener('click', () => {
    const isHidden = assignNewPanel.classList.contains('hidden');
    assignNewPanel.classList.toggle('hidden', !isHidden);
    if(isHidden){
      const titleInp = $('assign_new_title');
      if(titleInp) titleInp.focus();
    }
  });
}


const assignAssigneeSel = $('assign_assignee');
if(assignAssigneeSel) assignAssigneeSel.addEventListener('change', renderAssignable);

const assignTypeSel = $('assign_type');
if(assignTypeSel) assignTypeSel.addEventListener('change', renderAssignable);

const assignSortBySel = $('assign_sortBy');
if(assignSortBySel) assignSortBySel.addEventListener('change', renderAssignable);

const assignSortOrderSel = $('assign_sortOrder');
if(assignSortOrderSel) assignSortOrderSel.addEventListener('change', renderAssignable);

// Tag dropdown
const tagBtn = $('assign_tags_btn');
const tagMenu = $('assign_tags_menu');
const tagDd = $('assign_tags_dd');
if(tagBtn && tagMenu){
  tagBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tagMenu.classList.toggle('hidden');
  });
}
if(tagDd){
  tagDd.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('click', () => {
  if(tagMenu && !tagMenu.classList.contains('hidden')) tagMenu.classList.add('hidden');
});

document.querySelectorAll('input[name="assign_tag_mode"]').forEach(r => {
  r.addEventListener('change', renderAssignable);
});

// column sort buttons
const kanban = document.getElementById('assign_board');
if(kanban){
  kanban.querySelectorAll('.kanSortBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.closest('.kanCol');
      if(!col) return;
      const p = Number(col.getAttribute('data-priority') || '0');
      const mode = btn.getAttribute('data-sort') || 'default';
      if(p >= 0 && p <= 4){
        assignColumnSort[p] = mode;
        renderAssignable();
      }
    });
  });
}



/* -------------------- Kişisel Bazlı Performans -------------------- */

function monthNameTr(m){
  const names = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  return names[(m-1) % 12] || String(m);
}

function parseIsoDateOnly(s){
  if(!s) return null;
  try{
    const d = new Date(s);
    if(isNaN(d.getTime())) return null;
    return d;
  }catch{ return null; }
}

function initPerfView(){
  if(perfInitDone) return;
  perfInitDone = true;

  // Year/Month/Week dropdowns
  const ySel = $('perf_year');
  const mSel = $('perf_month');
  const wSel = $('perf_week');

  const now = new Date();
  const curY = now.getFullYear();

  if(ySel){
    ySel.innerHTML = '';
    for(let y = curY-4; y <= curY+1; y++){
      var op = document.createElement('option');
      op.value = String(y);
      op.textContent = String(y);
      if(y === curY) op.selected = true;
      ySel.appendChild(op);
    }
  }

  if(mSel){
    mSel.innerHTML = '';
    // All months
    {
      const opAll = document.createElement('option');
      opAll.value = '0';
      opAll.textContent = 'Tümü';
      mSel.appendChild(opAll);
    }
    for(let m=1; m<=12; m++){
      var op = document.createElement('option');
      var op = document.createElement('option');
      op.value = String(m);
      op.textContent = monthNameTr(m);
      if(m === (now.getMonth()+1)) op.selected = true;
      mSel.appendChild(op);
    }
  }

  if(wSel){
    wSel.innerHTML = '';
    const ops = [
      { v: 'all', t: 'Hepsi' },
      { v: '1', t: '1. hafta' },
      { v: '2', t: '2. hafta' },
      { v: '3', t: '3. hafta' },
      { v: '4', t: '4. hafta' },
      { v: '5', t: '5. hafta' },
    ];
    for(const o of ops){
      var op = document.createElement('option');
      op.value = o.v;
      op.textContent = o.t;
      if(o.v === 'all') op.selected = true;
      wSel.appendChild(op);
    }
  }

  // Users selector (multi-select list)
  renderPerfUsersSelect();

  const usersSel = $('perf_user');
  if(usersSel){
    usersSel.addEventListener('change', () => {
      perfActiveUser = usersSel.value || null;
      loadPerf();
    });
  }

  const refreshBtn = $('perf_refresh');
  if(refreshBtn) refreshBtn.addEventListener('click', loadPerf);

  if(ySel) ySel.addEventListener('change', () => loadPerfDone());
  if(mSel) mSel.addEventListener('change', () => loadPerfDone());
  if(wSel) wSel.addEventListener('change', () => loadPerfDone());

  // Canvas hover tooltip
  const canvas = $('perf_candle');
  if(canvas){
    canvas.addEventListener('mousemove', (e) => perfOnHover(e));
    canvas.addEventListener('mouseleave', () => perfHideTip());
  }
}

function perfUserLabel(u){
  if(!u) return '';
  const dn = (u.displayName || '').trim();
  if(dn) return dn;
  const un = (u.uniqueName || '').trim();
  if(!un) return '';
  const at = un.indexOf('@');
  return at > 0 ? un.slice(0, at) : un;
}

function perfPrettyName(s){
  const x = String(s || '').trim();
  if(!x) return '';
  // If it's like "Name <mail>" take the Name part
  const m = x.match(/^\s*([^<]+)\s*<[^>]+>\s*$/);
  if(m && m[1]) return m[1].trim();
  // If it looks like an email, title-case local part
  if(x.includes('@') && !x.includes(' ')){
    const local = x.split('@')[0];
    const parts = local.split(/[._-]+/).filter(Boolean);
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return x;
}

function renderPerfUsersSelect(){
  const sel = $('perf_user');
  if(!sel) return;

  // Ensure native dropdown (not listbox)
  sel.multiple = false;
  sel.removeAttribute('multiple');
  sel.removeAttribute('size');

  sel.innerHTML = '';

  const users = azdoUsers || [];
  if(users.length === 0) return;

  // default: first user
  if(!perfActiveUser){
    const first = users[0];
    const key = (first.uniqueName || first.displayName || '').trim();
    if(key) perfActiveUser = key;
  }

  for(const u of users){
    const key = (u.uniqueName || u.displayName || '').trim();
    if(!key) continue;
    var op = document.createElement('option');
    op.value = key;
    op.textContent = perfUserLabel(u);
    if(key === perfActiveUser) op.selected = true;
    sel.appendChild(op);
  }

  // ensure selected exists
  if(sel.options.length > 0 && !sel.value){
    sel.selectedIndex = 0;
    perfActiveUser = sel.value;
  }
}

async function loadPerf(){
  await loadPerfSummary();
  await loadPerfDone();
}

async function loadPerfSummary(){
  const status = $('perf_status');
  if(status) status.textContent = 'yükleniyor...';

  if(!perfActiveUser){
    perfSummary = [];
    renderPerfSummary();
    if(status) status.textContent = 'User seçilmedi.';
    return;
  }

  const params = new URLSearchParams();
  params.set('users', perfActiveUser);
  params.set('top', '2000');

  const { year, month, week } = getPerfPeriod();
  params.set('year', String(year));
  params.set('month', String(month));
  params.set('week', String(week));

  let res;
  try{
    res = await fetch('/api/performance/summary?' + params.toString());
  }catch{
    if(status) status.textContent = 'API erişilemedi.';
    return;
  }

  if(!res.ok){
    const err = await res.json().catch(() => null);
    if(status) status.textContent = err?.message || `API hata: ${res.status}`;
    return;
  }

  const data = await res.json();
  perfSummary = Array.isArray(data) ? data : [];
  renderPerfSummary();

  // set active user if missing
  if(!perfActiveUser && perfSummary.length > 0){
    perfActiveUser = perfSummary[0].user;
  }

  if(status) status.textContent = `ok (${perfSummary.length})`;
}

function renderPerfSummary(){
  const tbody = $('tbl_perf')?.querySelector('tbody');
  if(!tbody) return;

  tbody.innerHTML = '';
  const usersMap = new Map();
  for(const u of (azdoUsers || [])){
    const un = String(u.uniqueName || '').trim();
    const dn = String(u.displayName || '').trim();
    if(un){
      usersMap.set(un.toLowerCase(), u);
      // also map extracted email if identity contains "Name <mail>"
      const mm = un.match(/<([^>]+)>/);
      if(mm && mm[1]) usersMap.set(mm[1].trim().toLowerCase(), u);
    }
    if(dn) usersMap.set(dn.toLowerCase(), u);
  }

  for(const r of (perfSummary || [])){
    const tr = document.createElement('tr');
    tr.dataset.user = r.user || '';
    if(perfActiveUser && r.user === perfActiveUser) tr.classList.add('active');

    tr.addEventListener('click', () => {
      perfActiveUser = r.user || null;
      renderPerfSummary();
      loadPerfDone();
    });

    const uKey = String(r.user || '').trim().toLowerCase();
    const uObj = usersMap.get(uKey);
    const name = uObj ? perfUserLabel(uObj) : (r.displayName || perfPrettyName(r.user) || r.user || '');

    tr.appendChild(cell(name));
    tr.appendChild(cell(String(r.stories ?? 0)));
    tr.appendChild(cell(String(r.bugs ?? 0)));
    tr.appendChild(cell(String(r.todos ?? 0)));
    tr.appendChild(cell(String(r.inProgress ?? 0)));
    tr.appendChild(cell(String(r.done ?? 0)));

    tbody.appendChild(tr);
  }
}

function getPerfPeriod(){
  const year = parseInt(($('perf_year')?.value || ''), 10) || new Date().getFullYear();
  const rawMonth = String($('perf_month')?.value ?? '').trim();
  // month=0 => "Tümü" (yılın tamamı). parseInt("0") => 0, fakat "||" ile fallback'e düşmemeli.
  let month;
  if(rawMonth === '0'){
    month = 0;
  } else {
    const parsed = parseInt(rawMonth, 10);
    month = Number.isFinite(parsed) && parsed > 0 ? parsed : (new Date().getMonth()+1);
  }
  const week = ($('perf_week')?.value || 'all');
  return { year, month, week };
}

function getPerfRange(){
  const { year, month, week } = getPerfPeriod();
  // month=0 => full year
  if(month <= 0){
    const start = new Date(year, 0, 1);
    const endExclusive = new Date(year + 1, 0, 1);
    return { start, endExclusive };
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const w = String(week || 'all').trim().toLowerCase();
  const isAll = (w === '' || w === 'all' || w === 'hepsi');

  let startDay = 1;
  let endDay = daysInMonth;
  if(!isAll){
    let wn = parseInt(w, 10);
    if(!Number.isFinite(wn)) wn = 1;
    if(wn < 1) wn = 1;
    if(wn > 5) wn = 5;
    startDay = 1 + (wn - 1) * 7;
    if(startDay > daysInMonth) startDay = Math.max(1, daysInMonth - 6);
    endDay = Math.min(startDay + 6, daysInMonth);
  }

  // JS month is 0-based
  const start = new Date(year, month - 1, startDay);
  const endExclusive = new Date(year, month - 1, endDay + 1);
  return { start, endExclusive };
}


function buildPerfDailyStacks(items){
  const { start, endExclusive } = getPerfRange();
  const byDate = new Map();

  // Ensure the x-axis covers the whole selected period (week/month), even if some days have 0.
  const cur = new Date(start.getTime());
  while(cur < endExclusive){
    const key = cur.toLocaleDateString('sv-SE');
    byDate.set(key, { date: key, bugEff: 0, backlogEff: 0, bugItems: [], backlogItems: [] });
    cur.setDate(cur.getDate() + 1);
  }

  for(const it of (items || [])){
    const cd = it.completedDate;
    if(!cd) continue;
    const d = new Date(cd);
    if(isNaN(d.getTime())) continue;

    const dateKey = d.toLocaleDateString('sv-SE'); // yyyy-MM-dd (local)
    let bucket = byDate.get(dateKey);
    if(!bucket){
      // if API returned an item outside the range, ignore
      continue;
    }

    const type = (it.workItemType || '').toLowerCase();
    const eff = Number(it.effort) || 0;
    const id = Number(it.id) || 0;

    const isBug = type === 'bug' || type.includes('bug');
    if(isBug){
      bucket.bugEff += eff;
      bucket.bugItems.push({ id, effort: eff });
    }else{
      bucket.backlogEff += eff;
      bucket.backlogItems.push({ id, effort: eff });
    }
  }

  return Array.from(byDate.values()).sort((a,b) => a.date.localeCompare(b.date));
}


async function loadPerfDone(){
  const status = $('perf_status');
  if(!perfActiveUser){
    perfCandles = [];
    perfDoneItems = [];
    perfDailyStacks = [];
    renderPerfChart();
    renderPerfDoneTable();
    return;
  }

  const { year, month, week } = getPerfPeriod();

  const params = new URLSearchParams();
  params.set('user', perfActiveUser);
  params.set('year', String(year));
  params.set('month', String(month));
  params.set('week', String(week));
  params.set('top', '4000');

  let res;
  try{
    res = await fetch('/api/performance/done?' + params.toString());
  }catch{
    if(status) status.textContent = 'API erişilemedi.';
    return;
  }

  if(!res.ok){
    const err = await res.json().catch(() => null);
    if(status) status.textContent = err?.message || `API hata: ${res.status}`;
    return;
  }

  const data = await res.json();
  perfCandles = Array.isArray(data?.candles) ? data.candles : [];
  // Task'lar kesinlikle dışarıda (backend zaten elemekte, ekstra güvenlik)
  perfDoneItems = (Array.isArray(data?.items) ? data.items : []).filter(it => {
    const t = String(it?.workItemType || '').toLowerCase();
    return !t.includes('task');
  });

  // Sort by completed date ascending to match the selected period timeline.
  perfDoneItems.sort((a,b) => {
    const da = new Date(a?.completedDate || 0);
    const db = new Date(b?.completedDate || 0);
    const ta = isNaN(da.getTime()) ? 0 : da.getTime();
    const tb = isNaN(db.getTime()) ? 0 : db.getTime();
    if(ta !== tb) return ta - tb;
    return (Number(a?.id)||0) - (Number(b?.id)||0);
  });
  perfDoneById = new Map(perfDoneItems.map(it => [Number(it.id)||0, it]));
  perfDailyStacks = buildPerfDailyStacks(perfDoneItems);

  const title = $('perf_chart_title');
  if(title){
    const userObj = (azdoUsers || []).find(x => (x.uniqueName || x.displayName || '').trim() === perfActiveUser);
    const uName = userObj ? perfUserLabel(userObj) : perfActiveUser;
    const wTxt = (String(week) === 'all') ? 'Aylık' : `Hafta ${week}`;
    title.textContent = `${uName} • ${year} / ${monthNameTr(month)} • ${wTxt}`;
  }

  renderPerfChart();
  renderPerfMetrics();
  renderPerfDoneTable();
}

function renderPerfDoneTable(){
  const tbody = $('tbl_perf_done')?.querySelector('tbody');
  if(!tbody) return;

  tbody.innerHTML = '';

  for(const it of (perfDoneItems || [])){
    const t = String(it?.workItemType || '').toLowerCase();
    if(t.includes('task')) continue;
    const tr = document.createElement('tr');
    const wi = { id: it.id, title: it.title };

    tr.appendChild(idCell(wi));
    tr.appendChild(cell(it.title || ''));
    tr.appendChild(cell(it.workItemType || ''));
    tr.appendChild(cell(it.effort == null ? '' : String(it.effort)));

    tr.appendChild(cell(fmtDate(it.startDate)));
    tr.appendChild(cell(fmtDate(it.dueDate)));
    tr.appendChild(cell(fmtDate(it.completedDate)));

    tbody.appendChild(tr);
  }
}

function renderPerfMetrics(){
  const el = $('perf_metrics');
  if(!el) return;

  const items = perfDoneItems || [];

  let bugCnt = 0, backlogCnt = 0;
  let bugEff = 0, backlogEff = 0;
  let totalCnt = 0, totalEff = 0;

  for(const it of items){
    const eff = Number(it.effort) || 0;
    totalCnt += 1;
    totalEff += eff;

    const t = (it.workItemType || '').toLowerCase();
    if(t === 'bug' || t.includes('bug')){
      bugCnt += 1;
      bugEff += eff;
    }else{
      backlogCnt += 1;
      backlogEff += eff;
    }
  }

  // max day by (bug+backlog) effort
  let maxDay = '';
  let maxDayEff = 0;
  for(const d of (perfDailyStacks || [])){
    const v = (Number(d.backlogEff) || 0) + (Number(d.bugEff) || 0);
    if(v > maxDayEff){
      maxDayEff = v;
      maxDay = d.date;
    }
  }

  
  el.innerHTML = `
    <div class="metric">
      <div class="mLabel">Done (adet)</div>
      <div class="mVal">${totalCnt}</div>
    </div>
    <div class="metric">
      <div class="mLabel">Toplam Effort</div>
      <div class="mVal">${n2(totalEff)}</div>
    </div>
    <div class="metric">
      <div class="mLabel">Bug Effort</div>
      <div class="mVal">${n2(bugEff)} <span class="muted">(${bugCnt})</span></div>
    </div>
    <div class="metric">
      <div class="mLabel">Backlog Effort</div>
      <div class="mVal">${n2(backlogEff)} <span class="muted">(${backlogCnt})</span></div>
    </div>
    <div class="metric">
      <div class="mLabel">En yüksek gün</div>
      <div class="mVal">${n2(maxDayEff)}${maxDay ? ' • ' + maxDay : ''}</div>
    </div>
  `;

}



function perfHideTip(){
  const tip = $('perf_tip');
  if(tip) tip.classList.add('hidden');
}

function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function perfOnHover(e){
  const canvas = $('perf_candle');
  const tip = $('perf_tip');
  if(!canvas || !tip || !perfDailyStacks || perfDailyStacks.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Chart layout must match renderPerfChart()
  const W = canvas.width;
  const pad = { l: 56, r: 14, t: 18, b: 34 };
  const innerW = W - pad.l - pad.r;

  const n = perfDailyStacks.length;
  const step = innerW / Math.max(1, n);
  const xScaled = (x * (W/rect.width));
  const idx = Math.floor((xScaled - pad.l) / step);

  if(idx < 0 || idx >= n){
    tip.classList.add('hidden');
    return;
  }

  const d = perfDailyStacks[idx];
  const bug = Number(d.bugEff) || 0;
  const backlog = Number(d.backlogEff) || 0;

  const makeLine = (x) => {
    const wi = perfDoneById.get(Number(x.id)||0);
    const title = String(wi?.title || '').trim();
    // Keep full title (wrap in tooltip). If extremely long, truncate slightly.
    const t = title.length > 140 ? (title.slice(0, 137) + '...') : title;
    return { id: Number(x.id)||0, title: t, effort: Number(x.effort ?? 0) };
  };

  const bugLines = (d.bugItems || []).map(makeLine);
  const blLines = (d.backlogItems || []).map(makeLine);

  const rows = [];
  rows.push(`<div class="ttDate">${escapeHtml(d.date)}</div>`);

  rows.push(`<div class="ttGroup"><div class="ttHdr">Backlog: ${escapeHtml(n2(backlog))}</div>`);
  for(const x of blLines){
    rows.push(`<div class="ttLine">#${x.id} - ${escapeHtml(x.title)}: ${escapeHtml(n2(x.effort))}</div>`);
  }
  rows.push(`</div>`);

  rows.push(`<div class="ttGroup"><div class="ttHdr">Bug: ${escapeHtml(n2(bug))}</div>`);
  for(const x of bugLines){
    rows.push(`<div class="ttLine">#${x.id} - ${escapeHtml(x.title)}: ${escapeHtml(n2(x.effort))}</div>`);
  }
  rows.push(`</div>`);

  tip.innerHTML = rows.join('');

  // position: open right if fits; otherwise open to the left. Also keep within view.
  tip.classList.remove('hidden');
  tip.style.left = '0px';
  tip.style.top = '0px';

  const tipW = tip.offsetWidth || 320;
  const tipH = tip.offsetHeight || 160;

  let left = x + 12;
  if(left + tipW > rect.width) left = x - tipW - 12;
  if(left < 0) left = 0;

  let top = y + 12;
  if(top + tipH > rect.height) top = y - tipH - 12;
  if(top < 0) top = 0;

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function renderPerfChart(){
  const canvas = $('perf_candle');
  if(!canvas) return;

  const ctx = canvas.getContext('2d');
  if(!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0,0,W,H);

  const days = perfDailyStacks || [];
  if(days.length === 0){
    // empty state
    ctx.fillStyle = 'rgba(201,209,217,.65)';
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Seçilen aralıkta done item bulunamadı.', 28, 44);
    return;
  }

  const pad = { l: 56, r: 14, t: 18, b: 34 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  // Max total (bug+backlog)
  let maxV = 0;
  for(const d of days){
    const v = (Number(d.backlogEff) || 0) + (Number(d.bugEff) || 0);
    if(v > maxV) maxV = v;
  }
  if(maxV <= 0) maxV = 1;

  // Axes
  ctx.strokeStyle = 'rgba(201,209,217,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // y axis
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + innerH);
  // x axis
  ctx.lineTo(pad.l + innerW, pad.t + innerH);
  ctx.stroke();

  // Y ticks (4)
  ctx.fillStyle = 'rgba(201,209,217,.60)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  for(let i=0;i<=4;i++){
    const v = (maxV * (4-i) / 4);
    const y = pad.t + (innerH * i / 4);
    ctx.strokeStyle = 'rgba(201,209,217,.12)';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + innerW, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(201,209,217,.55)';
    ctx.fillText(n2(v), 6, y + 4);
  }

  const n = days.length;
  const step = innerW / Math.max(1, n);
  const barW = Math.max(12, Math.min(76, step * 0.85));
  const baseY = pad.t + innerH;

  function hFor(v){
    return (v / maxV) * innerH;
  }

  // Bars
  for(let i=0;i<n;i++){
    const d = days[i];
    const backlog = Number(d.backlogEff) || 0;
    const bug = Number(d.bugEff) || 0;

    const x0 = pad.l + i*step + (step - barW)/2;

    const hb = hFor(backlog);
    const hg = hFor(bug);

    ctx.lineWidth = 1.5;

    // backlog (blue)
    if(hb > 0){
      ctx.fillStyle = 'rgba(59,130,246,.55)';
      ctx.strokeStyle = 'rgba(59,130,246,1)';
      ctx.beginPath();
      ctx.rect(x0, baseY - hb, barW, hb);
      ctx.fill();
      ctx.stroke();
    }

    // bug (red) stacked
    if(hg > 0){
      ctx.fillStyle = 'rgba(239,68,68,.55)';
      ctx.strokeStyle = 'rgba(239,68,68,1)';
      ctx.beginPath();
      ctx.rect(x0, baseY - hb - hg, barW, hg);
      ctx.fill();
      ctx.stroke();
    }

    // X labels (avoid overlap on narrow screens)
    const minLabelPx = 44;
    const maxLabels = Math.max(2, Math.floor(innerW / minLabelPx));
    const interval = Math.max(1, Math.ceil(n / maxLabels));
    if(i % interval === 0 || i === n-1){
      ctx.fillStyle = 'rgba(201,209,217,.60)';
      ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      const lbl = String(d.date).slice(5); // MM-dd
      const tw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, x0 + (barW/2) - (tw/2), baseY + 20);
    }
  }

  // Legend
  const lx = pad.l + 8;
  const ly = pad.t + 6;
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

  ctx.fillStyle = 'rgba(59,130,246,.55)';
  ctx.strokeStyle = 'rgba(59,130,246,1)';
  ctx.beginPath(); ctx.rect(lx, ly, 10, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(201,209,217,.80)';
  ctx.fillText('Backlog', lx + 14, ly + 10);

  ctx.fillStyle = 'rgba(239,68,68,.55)';
  ctx.strokeStyle = 'rgba(239,68,68,1)';
  ctx.beginPath(); ctx.rect(lx + 84, ly, 10, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(201,209,217,.80)';
  ctx.fillText('Bug', lx + 98, ly + 10);
}


// main view tabs (Board / Review / Assign / Perf)
function initMainTabs(){
  const map = {
    board: 'viewTab_board',
    review: 'viewTab_review',
    assign: 'viewTab_assign',
    perf: 'viewTab_perf',
  };

  for(const [view, id] of Object.entries(map)){
    const el = $(id);
    if(!el) continue;
    el.addEventListener('click', () => {
      setView(view);
      try { history.replaceState(null, '', '#' + view); } catch {}
    });
  }

  const hash = (location.hash || '').replace('#','').trim();
  if(hash && map[hash]) setView(hash);
  else setView('board');
}



// tabs
const tabNoteBtn = $('tab_note');
const tabCommentBtn = $('tab_comment');
if(tabNoteBtn) tabNoteBtn.addEventListener('click', () => setActiveTab('note'));
if(tabCommentBtn) tabCommentBtn.addEventListener('click', () => setActiveTab('comment'));

const sendCommentBtn = $('sendComment');
if(sendCommentBtn) sendCommentBtn.addEventListener('click', sendComment);

initMainTabs();
load();


/* -------------------- Assign: Create / Edit Description -------------------- */

function htmlToText(html){
  try{
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').trim();
  }catch{
    return String(html || '').trim();
  }
}

function textToHtml(text){
  const s = String(text || '');
  return escapeHtml(s).replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n/g,'<br/>');
}

function ensureModalStyles(){
  if(document.getElementById('modalStyles')) return;
  const st = document.createElement('style');
  st.id = 'modalStyles';
  st.textContent = `

  .modalOverlay{
    position:fixed; inset:0;
    background:rgba(0,0,0,.55);
    display:flex; align-items:center; justify-content:center;
    z-index:9999;
  }
  .modalBox{
    width:min(980px, 94vw);
    max-height:88vh;
    overflow:auto;
    background:#0b1220;
    border:1px solid #223044;
    border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.45);
    padding:16px;
  }
  .modalTitle{ font-weight:700; margin:0 0 10px 0; color:#e6edf3; }
  .modalBody{ margin-top:6px; }
  .modalRow{ display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; }
  .modalRow label{
    display:flex; flex-direction:column; gap:6px;
    font-size:12px; color:rgba(255,255,255,.80);
  }
  .modalRow input, .modalRow select, .modalRow textarea{
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.10);
    color:#e6edf3;
    border-radius:10px;
    padding:9px 10px;
    outline:none;
  }
  .modalBody textarea, .modalRow textarea{
    width:100%;
    min-height:420px;
    resize:vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    line-height:1.45;
  }

  .richEditor{
    width:100%;
    min-height:520px;
    max-height:66vh;
    overflow:auto;
    padding:12px;
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.10);
    color:#e6edf3;
    border-radius:12px;
    line-height:1.45;
  }
  .richEditor:focus{ outline:1px solid rgba(43,116,255,.65); }
  .richEditor img{ max-width:100%; height:auto; display:block; margin:8px 0; }
  .mutedHint{ margin-top:8px; font-size:12px; color:rgba(255,255,255,.65); }
  .modalActions{ display:flex; gap:10px; justify-content:flex-end; margin-top:12px; }
  .btnPrimary{
    background:#2b74ff; border:0; padding:9px 12px;
    border-radius:10px; color:#fff; cursor:pointer; font-weight:600;
  }
  .btnGhost{
    background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12);
    padding:9px 12px; border-radius:10px; color:#fff; cursor:pointer;
  }

  `;
  document.head.appendChild(st);
}

function openModal(title, bodyEl, onSave){
  ensureModalStyles();
  const ov = document.createElement('div');
  ov.className = 'modalOverlay';
  ov.addEventListener('click', (e)=>{ if(e.target===ov) ov.remove(); });

  const box = document.createElement('div');
  box.className = 'modalBox';

  const h = document.createElement('h3');
  h.className = 'modalTitle';
  h.textContent = title;

  const actions = document.createElement('div');
  actions.className = 'modalActions';

  const btnCancel = document.createElement('button');
  btnCancel.type='button';
  btnCancel.className='btnGhost';
  btnCancel.textContent='Vazgeç';
  btnCancel.addEventListener('click', ()=> ov.remove());

  const btnSave = document.createElement('button');
  btnSave.type='button';
  btnSave.className='btnPrimary';
  btnSave.textContent='Kaydet';
  btnSave.addEventListener('click', async ()=>{
    try{
      btnSave.disabled = true;
      await onSave();
      ov.remove();
    }catch(err){
      const msg = (err && err.message) ? err.message : String(err || 'Hata');
      alert(msg);
    }finally{
      btnSave.disabled = false;
    }
  });

  actions.appendChild(btnCancel);
  actions.appendChild(btnSave);

  box.appendChild(h);
  box.appendChild(bodyEl);
  box.appendChild(actions);
  ov.appendChild(box);
  document.body.appendChild(ov);
  return ov;
}

async function patchDescription(workItemId, descriptionText){
  const res = await fetch(`/api/workitems/${workItemId}/description`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptionHtml: descriptionText })
  });
  if(!res.ok){
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  try{ return await res.json(); }catch{ return { ok:true }; }
}

async function createWorkItem(type, title, priority, descriptionText){
  const res = await fetch(`/api/workitems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workItemType: type, title, priority, description: descriptionText })
  });
  if(!res.ok){
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  return await res.json();
}

function openEditDescriptionModalGeneric(workItemId, currentHtml, afterSave){
  const body = document.createElement('div');
  body.className = 'modalBody';

  const editor = document.createElement('div');
  editor.className = 'richEditor';
  editor.contentEditable = 'true';
  editor.setAttribute('spellcheck','false');
  editor.innerHTML = htmlToEditorDisplayHtml(currentHtml || '');
  if(!editor.textContent.trim() && !editor.querySelector('img')){
    editor.innerHTML = '<div><br/></div>';
  }
  body.appendChild(editor);

  const hint = document.createElement('div');
  hint.className = 'mutedHint';
  hint.textContent = 'Resim eklemek için kopyala-yapıştır (Ctrl+V) yapabilirsin. Kaydet dediğinde Azure DevOps açıklaması güncellenir.';
  body.appendChild(hint);

  const uploadState = document.createElement('div');
  uploadState.className = 'mutedHint';
  uploadState.style.display = 'none';
  uploadState.textContent = 'Görsel yükleniyor...';
  body.appendChild(uploadState);

  let isUploading = false;

  editor.addEventListener('paste', async (e)=>{
    try{
      const cd = e.clipboardData;
      if(!cd || !cd.items || !cd.items.length) return;

      const imgItems = [...cd.items].filter(it => it && it.kind === 'file' && (it.type||'').toLowerCase().startsWith('image/'));
      if(!imgItems.length) return;

      e.preventDefault();

      for(const it of imgItems){
        const file = it.getAsFile && it.getAsFile();
        if(!file) continue;

        isUploading = true;
        uploadState.style.display = 'block';

        const originalUrl = await uploadWorkItemImage(workItemId, file);
        const proxyUrl = _proxyImg(originalUrl);
        const html = `<img src="${escapeHtml(proxyUrl)}" data-src-original="${escapeHtml(originalUrl)}" />`;
        insertHtmlAtCaret(html);
        insertHtmlAtCaret('<div><br/></div>');
      }
    }catch(err){
      console.error(err);
      alert('Görsel eklenemedi: ' + (err && err.message ? err.message : String(err)));
    }finally{
      isUploading = false;
      uploadState.style.display = 'none';
    }
  });

  openModal(`#${workItemId} Açıklama`, body, async ()=>{
    if(isUploading) throw new Error('Görsel yüklemesi bitmeden kaydedemezsin.');
    const html = editorDisplayToSaveHtml(editor.innerHTML);
    const r = await patchDescription(workItemId, html);
    const newHtml = (r && r.descriptionHtml != null) ? String(r.descriptionHtml) : html;
    if(typeof afterSave === 'function') afterSave(newHtml);
  });

}


function openEditDescriptionModal(item){
  openEditDescriptionModalGeneric(item.id, item.descriptionHtml || '', (newHtml)=>{
    item.descriptionHtml = newHtml;
    renderAssignable();
  });
}

async function createNewAssignItem(){
  const typeSel = $('assign_new_type');
  const priSel = $('assign_new_priority');
  const titleInp = $('assign_new_title');
  if(!typeSel || !priSel || !titleInp) return;

  const workItemType = String(typeSel.value || 'Product Backlog Item');
  const priority = Number(priSel.value || '4');
  const title = String(titleInp.value || '').trim();
  if(!title){
    titleInp.focus();
    return;
  }

  const status = $('assign_status');
  if(status) status.textContent = 'Oluşturuluyor...';

  try{
    const res = await fetch('/api/workitems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workItemType, title, description: '', priority, addToTop: true })
    });
    if(!res.ok){
      const t = await res.text();
      throw new Error(t || ('HTTP ' + res.status));
    }

    const created = await res.json();
    // optimistic insert at top of its column (new items should appear immediately)
    titleInp.value = '';
    if(status) status.textContent = `Oluşturuldu: #${created.id}`;

    // reload to ensure all fields/state are in sync
    await loadAssignableItems();
  }catch(err){
    if(status) status.textContent = 'Oluşturma hatası: ' + (err?.message || err);
  }
}

function openCreateWorkItemModal(){
  const body = document.createElement('div');

  const row1 = document.createElement('div');
  row1.className='modalRow';

  const lType = document.createElement('label');
  lType.innerHTML = 'Tür';
  const selType = document.createElement('select');
  selType.innerHTML = `
    <option value="Product Backlog Item" selected>Product Backlog Item</option>
    <option value="Bug">Bug</option>
  `;
  lType.appendChild(selType);

  const lPri = document.createElement('label');
  lPri.innerHTML = 'Priority';
  const selPri = document.createElement('select');
  selPri.innerHTML = `
    <option value="1">1</option>
    <option value="2">2</option>
    <option value="3">3</option>
    <option value="4" selected>4</option>
  `;
  lPri.appendChild(selPri);

  row1.appendChild(lType);
  row1.appendChild(lPri);

  const row2 = document.createElement('div');
  row2.className='modalRow';

  const lTitle = document.createElement('label');
  lTitle.style.flex='1 1 520px';
  lTitle.innerHTML = 'Başlık';
  const inTitle = document.createElement('input');
  inTitle.type='text';
  inTitle.placeholder='Örn: Kiosk raporu iyileştirme';
  lTitle.appendChild(inTitle);
  row2.appendChild(lTitle);

  const row3 = document.createElement('div');
  row3.className='modalRow';
  const lDesc = document.createElement('label');
  lDesc.style.width='100%';
  lDesc.innerHTML = 'Açıklama';
  const ta = document.createElement('textarea');
  ta.placeholder='Açıklamayı yaz...';
  lDesc.appendChild(ta);
  row3.appendChild(lDesc);

  body.appendChild(row1);
  body.appendChild(row2);
  body.appendChild(row3);

  openModal('Yeni Madde Oluştur', body, async ()=>{
    const type = selType.value;
    const pri = parseInt(selPri.value,10);
    const title = (inTitle.value || '').trim();
    if(!title) throw new Error('Başlık boş olamaz.');
    await createWorkItem(type, title, pri, ta.value);
    await loadAssignableItems(); // refresh to show new item
  });
}


function truncateText(s, maxLen){
  const t = String(s || '');
  if(t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen-1)) + '…';
}