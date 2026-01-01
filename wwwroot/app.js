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
  // Beklenen format:
  // https://dev.azure.com/Adisyo/adisyo-mill/_boards/board/t/Platform%20Team/Backlog%20items?workitem=XXX
  const orgUrl = (azdoCfg?.organizationUrl || '').trim().replace(/\/+$/,'');
  const project = (azdoCfg?.project || '').trim();
  const team = (azdoCfg?.team || 'Platform Team').trim() || 'Platform Team';

  if(!orgUrl || !project) return '#';

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

function cell(txt){
  const td = document.createElement('td');
  td.textContent = txt ?? '';
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

function forecastClass(wi){
  // Start+Effort varsa ve Due ile ForecastDue uyuşmuyorsa renklendir
  if(!wi.startDate) return '';
  if(wi.effort == null) return '';
  if(!wi.dueDate || !wi.forecastDueDate) return '';

  const due = dateKey(wi.dueDate);
  const fc = dateKey(wi.forecastDueDate);
  if(!due || !fc) return '';

  if(due === fc) return '';

  return (fc > due) ? 'late' : 'early';
}

function overdueClass(wi){
  // Uyarı: Due bugünün (local) tarihi veya öncesindeyse
  if(!wi.dueDate) return '';
  const due = dateKey(wi.dueDate);
  if(!due) return '';
  const today = todayKey();
  return (due <= today) ? 'overdue' : '';
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
  }catch(e){
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

    const fcls = forecastClass(wi);
    const ocls = overdueClass(wi);
    if(wi.needsFeedback) tr.classList.add('pool');
    if(fcls) tr.classList.add(fcls); // late / early
    if(ocls) tr.classList.add(ocls);

    tr.appendChild(cell(wi.id));
    tr.appendChild(titleCell(wi));
    tr.appendChild(cell(wi.assignedToUniqueName ?? wi.assignedToDisplayName ?? ''));
    tr.appendChild(cell(wi.state));
    tr.appendChild(cell(wi.effort ?? ''));
    tr.appendChild(cell(fmtDate(wi.startDate)));
    tr.appendChild(cell(fmtDate(wi.dueDate)));
    tr.appendChild(cell(fmtDate(wi.doneDate)));
    tr.appendChild(cell(wi.expectedDays ?? ''));
    tr.appendChild(cell(fmtDate(wi.forecastDueDate)));
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

  // paneli önce aç, kullanıcı görsün
  $('detail').classList.remove('hidden');
  $('d_title').textContent = `#${id}`;
  $('d_meta').textContent = 'yükleniyor...';
  const descEl = $('d_desc');
  if(descEl) descEl.textContent = 'yükleniyor...';

  let res;
  try{
    res = await fetch('/api/workitems/' + id);
  }catch(e){
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

  const boardUrl = buildBoardUrl(wi.id);
  $('d_url').href = boardUrl;

  const iframe = $('d_iframe');
  if(iframe) iframe.src = '';
  const wrap = $('d_embed_wrap');
  if(wrap) wrap.classList.add('hidden');

  renderList('fb_list', (data.feedback || []).map(f => `${fmtDate(f.createdAt)} - ${f.note}`));

  // description (Program.cs: descriptionHtml)
  if(descEl){
    const desc = htmlToText(data.descriptionHtml);
    descEl.textContent = desc ? desc : '(açıklama yok)';
  }
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

$('refresh').addEventListener('click', load);
$('close').addEventListener('click', () => $('detail').classList.add('hidden'));
$('sendFb').addEventListener('click', sendFeedback);

// Azure DevOps'u iframe ile dene
$('d_open_embed').addEventListener('click', async () => {
  if(!currentId) return;
  await ensureConfig();
  const url = buildBoardUrl(currentId);
  const wrap = $('d_embed_wrap');
  const iframe = $('d_iframe');
  if(!wrap || !iframe) return;
  iframe.src = url;
  wrap.classList.remove('hidden');
});

load();
