const $ = (id) => document.getElementById(id);

let currentId = null;
let azdoCfg = null;

let activeView = 'board'; // 'board' | 'review' | 'assign' | 'perf'

let assignItems = [];
let assignLoaded = false;
let assignColumnSort = { 0: 'default', 1: 'default', 2: 'default', 3: 'default', 4: 'default' };

let perfLoaded = false;
let perfInitDone = false;
let perfSelectedUsers = [];
let perfActiveUser = null;
let perfSummary = [];
let perfCandles = [];
let perfDoneItems = [];
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
    ensureConfig().then(() => {
      if(!assignLoaded) loadAssignableItems();
      else renderAssignable();
    });
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
  div.className = `aCard ${cls}`.trim();

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
      ${assignee ? `<span class="aAssignee">${escapeHtml(assignee)}</span>` : `<span class="aAssignee muted">Unassigned</span>`}
    </div>
    <div class="aDates">
      <span>Created: ${fmtDate(item.createdDate)}</span>
      <span>Changed: ${fmtDate(item.changedDate)}</span>
    </div>
    <div class="aTags">${renderTagChips(tags)}</div>
  `;

  // Title click -> existing detail screen works only for In Progress items; so keep it as link to ADO
  return div;
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

  const assSel = $('assign_assignee')?.value || '';
  const typeSel = $('assign_type')?.value || '';
  const sortBy = $('assign_sortBy')?.value || 'changed';
  const sortOrder = $('assign_sortOrder')?.value || 'desc';
  const tagMode = getTagMode();
  const selectedTags = getSelectedTags();

  const filtered = (assignItems || []).filter(x => {
    const isStory = String(x.workItemType || '').toLowerCase() === 'user story';
    const typeOk = isStory ? true : itemPassType(x, typeSel);
    return typeOk && itemPassAssignee(x, assSel) && itemPassTags(x, selectedTags, tagMode);
  });

  const stories = filtered.filter(x => String(x.workItemType || '').toLowerCase() === 'user story');
  const others = filtered.filter(x => String(x.workItemType || '').toLowerCase() !== 'user story');

  const sortedStories = sortByKey(stories, sortBy, sortOrder);
  const sortedOthers = sortByKey(others, sortBy, sortOrder);

  storiesBox.innerHTML = '';
  // story column has its own per-column override
  function applyColSort(arr, p){
    const mode = assignColumnSort[p] || 'default';
    if(mode === 'oldest'){
      return arr.slice().sort((a,b) => (+new Date(a.createdDate) - +new Date(b.createdDate)) || (a.orderIndex - b.orderIndex));
    }
    if(mode === 'newest'){
      return arr.slice().sort((a,b) => (+new Date(b.createdDate) - +new Date(a.createdDate)) || (a.orderIndex - b.orderIndex));
    }
    return arr;
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
      const op = document.createElement('option');
      op.value = String(y);
      op.textContent = String(y);
      if(y === curY) op.selected = true;
      ySel.appendChild(op);
    }
  }

  if(mSel){
    mSel.innerHTML = '';
    for(let m=1; m<=12; m++){
      const op = document.createElement('option');
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
      const op = document.createElement('option');
      op.value = o.v;
      op.textContent = o.t;
      if(o.v === 'all') op.selected = true;
      wSel.appendChild(op);
    }
  }

  // Users dropdown (multi-select)
  renderPerfUsersDropdown();

  const usersBtn = $('perf_users_btn');
  const usersMenu = $('perf_users_menu');
  const usersDd = $('perf_users_dd');

  if(usersBtn && usersMenu){
    usersBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      usersMenu.classList.toggle('hidden');
    });
  }
  if(usersDd) usersDd.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if(usersMenu && !usersMenu.classList.contains('hidden')) usersMenu.classList.add('hidden');
  });

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

function renderPerfUsersDropdown(){
  const list = $('perf_users_list');
  const btn = $('perf_users_btn');
  if(!list || !btn) return;

  list.innerHTML = '';

  const users = azdoUsers || [];
  if(users.length === 0){
    btn.textContent = 'Users';
    return;
  }

  // default: select first user
  if(!perfSelectedUsers || perfSelectedUsers.length === 0){
    const first = users[0];
    const key = (first.uniqueName || first.displayName || '').trim();
    if(key) perfSelectedUsers = [key];
    perfActiveUser = key;
  }

  // rebuild list
  for(const u of users){
    const key = (u.uniqueName || u.displayName || '').trim();
    if(!key) continue;

    const row = document.createElement('label');
    row.className = 'tagItem';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = perfSelectedUsers.includes(key);
    cb.addEventListener('change', () => {
      if(cb.checked){
        if(!perfSelectedUsers.includes(key)) perfSelectedUsers.push(key);
        if(!perfActiveUser) perfActiveUser = key;
      }else{
        perfSelectedUsers = perfSelectedUsers.filter(x => x !== key);
        if(perfActiveUser === key) perfActiveUser = perfSelectedUsers[0] || null;
      }
      updatePerfUsersButton();
      loadPerf();
    });

    const sp = document.createElement('span');
    sp.textContent = perfUserLabel(u);

    row.appendChild(cb);
    row.appendChild(sp);
    list.appendChild(row);
  }

  updatePerfUsersButton();
}

function updatePerfUsersButton(){
  const btn = $('perf_users_btn');
  if(!btn) return;
  const cnt = (perfSelectedUsers || []).length;
  btn.textContent = cnt > 0 ? `Users (${cnt})` : 'Users';
}

async function loadPerf(){
  await loadPerfSummary();
  await loadPerfDone();
}

async function loadPerfSummary(){
  const status = $('perf_status');
  if(status) status.textContent = 'yükleniyor...';

  if(!perfSelectedUsers || perfSelectedUsers.length === 0){
    perfSummary = [];
    renderPerfSummary();
    if(status) status.textContent = 'User seçilmedi.';
    return;
  }

  const params = new URLSearchParams();
  params.set('users', perfSelectedUsers.join(','));
  params.set('top', '2000');

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
  const usersMap = new Map((azdoUsers || []).map(u => [(u.uniqueName || u.displayName || '').trim(), u]));

  for(const r of (perfSummary || [])){
    const tr = document.createElement('tr');
    tr.dataset.user = r.user || '';
    if(perfActiveUser && r.user === perfActiveUser) tr.classList.add('active');

    tr.addEventListener('click', () => {
      perfActiveUser = r.user || null;
      renderPerfSummary();
      loadPerfDone();
    });

    const uObj = usersMap.get(r.user || '');
    const name = uObj ? perfUserLabel(uObj) : (r.displayName || r.user || '');

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
  const month = parseInt(($('perf_month')?.value || ''), 10) || (new Date().getMonth()+1);
  const week = ($('perf_week')?.value || 'all');
  return { year, month, week };
}

async function loadPerfDone(){
  const status = $('perf_status');
  if(!perfActiveUser){
    perfCandles = [];
    perfDoneItems = [];
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
  perfDoneItems = Array.isArray(data?.items) ? data.items : [];

  const title = $('perf_chart_title');
  if(title){
    const userObj = (azdoUsers || []).find(x => (x.uniqueName || x.displayName || '').trim() === perfActiveUser);
    const uName = userObj ? perfUserLabel(userObj) : perfActiveUser;
    const wTxt = (String(week) === 'all') ? 'Aylık' : `Hafta ${week}`;
    title.textContent = `${uName} • ${year} / ${monthNameTr(month)} • ${wTxt}`;
  }

  renderPerfChart();
  renderPerfDoneTable();
}

function renderPerfDoneTable(){
  const tbody = $('tbl_perf_done')?.querySelector('tbody');
  if(!tbody) return;

  tbody.innerHTML = '';

  for(const it of (perfDoneItems || [])){
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

function perfHideTip(){
  const tip = $('perf_tip');
  if(tip) tip.classList.add('hidden');
}

function perfOnHover(e){
  const canvas = $('perf_candle');
  const tip = $('perf_tip');
  if(!canvas || !tip || !perfCandles || perfCandles.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Chart layout must match renderPerfChart()
  const W = canvas.width;
  const H = canvas.height;
  const pad = { l: 46, r: 12, t: 18, b: 28 };
  const innerW = W - pad.l - pad.r;

  const n = perfCandles.length;
  const step = innerW / Math.max(1, n);
  const idx = Math.floor((x * (W/rect.width) - pad.l) / step);

  if(idx < 0 || idx >= n){
    tip.classList.add('hidden');
    return;
  }

  const c = perfCandles[idx];
  const items = (c.items || []).map(x => `#${x.id}: ${x.effort ?? 0}`).join(', ');
  tip.textContent = `${c.date}\nOpen: ${c.open ?? 0}  High: ${c.high ?? 0}  Low: ${c.low ?? 0}  Close: ${c.close ?? 0}\n${items || '(madde yok)'}`;

  // position
  tip.style.left = Math.min((x+12), rect.width - 30) + 'px';
  tip.style.top = Math.min((y+12), rect.height - 30) + 'px';
  tip.classList.remove('hidden');
}

function renderPerfChart(){
  const canvas = $('perf_candle');
  if(!canvas) return;

  const ctx = canvas.getContext('2d');
  if(!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // clear
  ctx.clearRect(0,0,W,H);

  const pad = { l: 46, r: 12, t: 18, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  // axis
  ctx.strokeStyle = 'rgba(255,255,255,.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + innerH);
  ctx.lineTo(pad.l + innerW, pad.t + innerH);
  ctx.stroke();

  const candles = perfCandles || [];
  if(candles.length === 0){
    ctx.fillStyle = 'rgba(201,209,217,.65)';
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Bu aralıkta Done veri yok.', pad.l + 10, pad.t + 24);
    return;
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for(const c of candles){
    const lo = (c.low ?? 0);
    const hi = (c.high ?? 0);
    if(lo < minV) minV = lo;
    if(hi > maxV) maxV = hi;
  }
  if(!isFinite(minV)) minV = 0;
  if(!isFinite(maxV)) maxV = 1;
  if(maxV === minV) maxV = minV + 1;

  function yFor(v){
    const t = (v - minV) / (maxV - minV);
    return pad.t + innerH - (t * innerH);
  }

  // Y labels (3 ticks)
  ctx.fillStyle = 'rgba(201,209,217,.65)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  for(let i=0; i<=2; i++){
    const v = minV + (i*(maxV-minV)/2);
    const y = yFor(v);
    ctx.fillText(String(Math.round(v*100)/100), 6, y+4);
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l+innerW, y);
    ctx.stroke();
  }

  const n = candles.length;
  const step = innerW / n;
  const candleW = Math.max(4, step * 0.55);

  for(let i=0; i<n; i++){
    const c = candles[i];
    const cx = pad.l + i*step + step/2;

    const o = (c.open ?? 0);
    const cl = (c.close ?? 0);
    const hi = (c.high ?? 0);
    const lo = (c.low ?? 0);

    const yHi = yFor(hi);
    const yLo = yFor(lo);
    const yO = yFor(o);
    const yC = yFor(cl);

    // wick
    ctx.strokeStyle = 'rgba(201,209,217,.65)';
    ctx.beginPath();
    ctx.moveTo(cx, yHi);
    ctx.lineTo(cx, yLo);
    ctx.stroke();

    // body
    const top = Math.min(yO, yC);
    const bot = Math.max(yO, yC);
    const h = Math.max(2, bot - top);

    ctx.fillStyle = (cl >= o) ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)';
    ctx.strokeStyle = (cl >= o) ? 'rgba(16,185,129,.65)' : 'rgba(239,68,68,.65)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.rect(cx - candleW/2, top, candleW, h);
    ctx.fill();
    ctx.stroke();

    // X labels: every ~5
    if(n <= 12 || (i % Math.ceil(n/10) === 0)){
      ctx.fillStyle = 'rgba(201,209,217,.55)';
      ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(String(c.date).slice(5), cx - 18, pad.t + innerH + 18);
    }
  }
}


// tabs
const tabNoteBtn = $('tab_note');
const tabCommentBtn = $('tab_comment');
if(tabNoteBtn) tabNoteBtn.addEventListener('click', () => setActiveTab('note'));
if(tabCommentBtn) tabCommentBtn.addEventListener('click', () => setActiveTab('comment'));

const sendCommentBtn = $('sendComment');
if(sendCommentBtn) sendCommentBtn.addEventListener('click', sendComment);

setView('board');
load();
