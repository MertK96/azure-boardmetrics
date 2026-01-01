const $ = (id) => document.getElementById(id);

let currentId = null;
let azdoCfg = null;

function pad2(n){ return String(n).padStart(2,'0'); }

function ymdLocal(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function todayKey(){
  return ymdLocal(new Date());
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
  // Ä°stenen format:
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
 * Not: Start+Effort+Due+ForecastDue varsa anlamlÄ±.
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
 * Due geÃ§miÅŸ mi? (commitment uyarÄ±sÄ±)
 * Ä°stek: Startâ†’Due ayrÄ± renk (pratikte Due <= Today olduÄŸunda belirginleÅŸir)
 */
function commitmentOverdue(wi){
  if(!wi.dueDate) return false;
  const due = dateKey(wi.dueDate);
  if(!due) return false;
  return due <= todayKey();
}

/**
 * ForecastDue geÃ§miÅŸ mi? (forecast uyarÄ±sÄ±)
 * Ä°stek: Startâ†’ForecastDue ayrÄ± renk (pratikte ForecastDue <= Today olduÄŸunda belirginleÅŸir)
 */
function forecastOverdue(wi){
  if(!wi.forecastDueDate) return false;
  const fc = dateKey(wi.forecastDueDate);
  if(!fc) return false;
  return fc <= todayKey();
}

// Description HTML'i gÃ¼venli ÅŸekilde text'e Ã§evir
function htmlToText(html){
  if(!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html; // sadece textContent almak iÃ§in
  return (tmp.textContent || tmp.innerText || '').trim();
}

async function load(){
  await ensureConfig();
  $('status').textContent = 'yÃ¼kleniyor...';

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
    $('status').textContent = 'API eriÅŸilemedi.';
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

    // Due / ForecastDue geÃ§miÅŸ mi?
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
  $('d_title').textContent = `#${id}`;
  $('d_meta').textContent = 'yÃ¼kleniyor...';
  const descEl = $('d_desc');
  if(descEl) descEl.textContent = 'yÃ¼kleniyor...';

  let res;
  try{
    res = await fetch('/api/workitems/' + id);
  }catch{
    $('d_meta').textContent = 'Detay API eriÅŸilemedi.';
    if(descEl) descEl.textContent = '(aÃ§Ä±klama yok)';
    return;
  }

  if(!res.ok){
    $('d_meta').textContent = `Detay API hata: ${res.status}`;
    if(descEl) descEl.textContent = '(aÃ§Ä±klama yok)';
    return;
  }

  const data = await res.json();
  const wi = data.workItem;

  if(!wi){
    $('d_meta').textContent = 'Detay verisi boÅŸ dÃ¶ndÃ¼.';
    if(descEl) descEl.textContent = '(aÃ§Ä±klama yok)';
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
    descEl.textContent = desc ? desc : '(aÃ§Ä±klama yok)';
  }
}

function renderList(id, items){
  const el = $(id);
  el.innerHTML = '';
  if(!items || items.length === 0){
    el.textContent = '(boÅŸ)';
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

$('refresh').addEventListener('click', load);
$('close').addEventListener('click', () => $('detail').classList.add('hidden'));
$('sendFb').addEventListener('click', sendFeedback);

load();
