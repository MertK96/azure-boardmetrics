const $ = (id) => document.getElementById(id);

let currentId = null;
let azdoCfg = null;

let activeView = 'board'; // 'board' | 'review'
let azdoUsersLoaded = false;
let azdoUsers = [];

let activeTab = 'note'; // 'note' | 'comment'

function pad2(n){ return String(n).padStart(2,'0'); }

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
  const viewBoard = $('view_board');
  const viewReview = $('view_review');

  if(btnBoard) btnBoard.classList.toggle('active', view === 'board');
  if(btnReview) btnReview.classList.toggle('active', view === 'review');

  if(viewBoard) viewBoard.classList.toggle('hidden', view !== 'board');
  if(viewReview) viewReview.classList.toggle('hidden', view !== 'review');

  if(view === 'review'){
    ensureAzdoUsers().then(loadReviewItems);
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

async function load(){
  await ensureConfig();
  $('status').textContent = 'yükleniyor...';

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
    const desc = htmlToText(data.descriptionHtml);
    descEl.textContent = desc ? desc : '(açıklama yok)';
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


$('refresh').addEventListener('click', load);
$('close').addEventListener('click', () => $('detail').classList.add('hidden'));
$('sendFb').addEventListener('click', sendFeedback);

// view tabs
const boardBtn = $('viewTab_board');
const reviewBtn = $('viewTab_review');
if(boardBtn) boardBtn.addEventListener('click', () => setView('board'));
if(reviewBtn) reviewBtn.addEventListener('click', () => setView('review'));

const reviewRefreshBtn = $('review_refresh');
if(reviewRefreshBtn) reviewRefreshBtn.addEventListener('click', loadReviewItems);


// tabs
const tabNoteBtn = $('tab_note');
const tabCommentBtn = $('tab_comment');
if(tabNoteBtn) tabNoteBtn.addEventListener('click', () => setActiveTab('note'));
if(tabCommentBtn) tabCommentBtn.addEventListener('click', () => setActiveTab('comment'));

const sendCommentBtn = $('sendComment');
if(sendCommentBtn) sendCommentBtn.addEventListener('click', sendComment);

setView('board');
load();
