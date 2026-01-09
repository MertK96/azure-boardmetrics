(function(){
  function $(id){ return document.getElementById(id); }

  const COL_IDS = ['assign_col_story','assign_col_p1','assign_col_p2','assign_col_p3','assign_col_p4'];

  let dragged = null;

  function getPriorityFromColId(colId){
    if(colId === 'assign_col_p1') return 1;
    if(colId === 'assign_col_p2') return 2;
    if(colId === 'assign_col_p3') return 3;
    if(colId === 'assign_col_p4') return 4;
    return null;
  }

  function getInsertAfter(container, y){
    const cards = Array.from(container.querySelectorAll('.aCard:not(.dragging)'));
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for(const el of cards){
      const box = el.getBoundingClientRect();
      const offset = y - (box.top + box.height / 2);
      if(offset < 0 && offset > closest.offset){
        closest = { offset, element: el };
      }
    }
    return closest.element;
  }

  async function sendMove(cardEl, toColId, beforeEl, afterEl){
    const id = parseInt(cardEl?.dataset?.id || '0', 10);
    if(!id) return;

    const pr = getPriorityFromColId(toColId);
    if(!pr) return;

    const fromStories = !!cardEl.closest('#assign_col_story');
    const setApproved = fromStories && toColId !== 'assign_col_story';

    const body = {
      priority: pr,
      setApproved: !!setApproved,
      beforeId: beforeEl ? parseInt(beforeEl.dataset.id || '0',10) : null,
      afterId: afterEl ? parseInt(afterEl.dataset.id || '0',10) : null
    };

    const res = await fetch(`/api/assignments/${id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if(!res.ok){
      const err = await res.json().catch(()=>null);
      const msg = err?.message || `Move failed: ${res.status}`;
      alert(msg);
      // fallback: refresh assign view if available
      if(typeof window.loadAssignableItems === 'function'){
        try{ await window.loadAssignableItems(); }catch{}
      }
    }
  }

  function wireColumn(col){
    col.addEventListener('dragover', (e)=>{
      e.preventDefault();
      const afterEl = getInsertAfter(col, e.clientY);
      const dragging = document.querySelector('.aCard.dragging');
      if(!dragging) return;

      if(afterEl == null){
        col.appendChild(dragging);
      }else{
        col.insertBefore(dragging, afterEl);
      }
    });

    col.addEventListener('drop', async (e)=>{
      e.preventDefault();
      const dragging = document.querySelector('.aCard.dragging');
      if(!dragging) return;

      const children = Array.from(col.querySelectorAll('.aCard'));
      const idx = children.indexOf(dragging);
      const beforeEl = (idx > 0) ? children[idx-1] : null;
      const afterEl = (idx >= 0 && idx < children.length-1) ? children[idx+1] : null;

      await sendMove(dragging, col.id, beforeEl, afterEl);
    });
  }

  function wireCards(root){
    root.querySelectorAll('.aCard[draggable="true"]').forEach(card=>{
      if(card.__dd_wired) return;
      card.__dd_wired = true;

      card.addEventListener('dragstart', ()=>{
        dragged = card;
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', ()=>{
        card.classList.remove('dragging');
        dragged = null;
      });
    });
  }

  function init(){
    const cols = COL_IDS.map(id=>$(id)).filter(Boolean);
    if(cols.length===0) return;

    cols.forEach(wireColumn);

    // initial wire
    cols.forEach(wireCards);

    // re-wire on re-render (cards recreated)
    const obs = new MutationObserver(()=>{
      cols.forEach(wireCards);
    });
    cols.forEach(c=>obs.observe(c, { childList: true, subtree: true }));
  }

  window.addEventListener('DOMContentLoaded', init);
})();