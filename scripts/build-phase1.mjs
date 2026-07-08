// Drives the REAL builder UI (headless Chrome over CDP) to construct the
// Phase-1 "Agency Bulk Upload — Daily Intake" workflow node-by-node from
// docs/phase1-agency-upload.graph.json, assigning tasks to the DEMO-RCM
// employee. daily_time hour/minute/tz are set via the identical saveWorkflow
// endpoint after the UI save (the TriggerCard UI has no hour/minute/tz inputs).
import fs from 'node:fs';
import { connect } from './cdp.mjs';

const GRAPH = JSON.parse(fs.readFileSync('/Users/sujaygp/Desktop/poc/docs/phase1-agency-upload.graph.json', 'utf8'));
const EMP_ID = 'b8f2826d-ade5-4384-bdfd-610a486c39a0'; // Intake Coordinator (DEMO-RCM)
const BASE = 'http://localhost:8791';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a by-id map + a nested "seq" tree from the graph's linked list, mirroring
// the builder's graphToSeq (chainToSeq stops each branch at its join id).
const byId = new Map(GRAPH.graph.nodes.map((n) => [n.id, n]));
function chainToSeq(startId, stopId) {
  const seq = [];
  let cur = startId;
  const guard = new Set();
  while (cur && cur !== stopId && !guard.has(cur)) {
    guard.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    if (node.kind === 'condition') {
      seq.push({
        kind: 'condition',
        conditionKey: node.conditionKey,
        ifTrue: node.ifTrue ? chainToSeq(node.ifTrue, node.join || null) : [],
        ifFalse: node.ifFalse ? chainToSeq(node.ifFalse, node.join || null) : [],
      });
      cur = node.join || null;
    } else if (node.kind === 'task') {
      seq.push({
        kind: 'task',
        name: node.name,
        actions: (node.actions || []).map((a) => ({ actionKey: a.actionKey, label: a.label || '' })),
      });
      cur = node.next || null;
    } else {
      seq.push({ kind: 'system', name: node.name, actionKey: node.actionKey });
      cur = node.next || null;
    }
  }
  return seq;
}
const ROOT_SEQ = chainToSeq(GRAPH.graph.entry, null);

async function main() {
  const p = await connect({ port: 9222 });
  await p.navigate(`${BASE}/builder/workflows`);
  await sleep(2000);

  // Inject a reusable DOM toolkit into the page (React-aware value setter,
  // path-addressable sequence editor walker).
  await p.evaluate(TOOLKIT);

  // Open a fresh editor.
  await p.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='New workflow');
    b.click(); return true;
  })()`);
  await sleep(2000);
  // Re-inject toolkit (page did not navigate, but be safe if React remounted).
  await p.evaluate(TOOLKIT);

  // Name + description.
  await setField(p, 'name', GRAPH.name);
  await setField(p, 'description', GRAPH.description);

  // Select the daily_time trigger radio.
  await p.evaluate(`window.__cc.pickTrigger('Daily at time')`);
  await sleep(400);

  // Build the sequence.
  await buildSeq(p, [], ROOT_SEQ);

  // Report the editor's node count for a sanity check.
  const counts = await p.evaluate(`window.__cc.summary()`);
  console.log('EDITOR SUMMARY:', JSON.stringify(counts));

  // Save via the UI button.
  const saveRes = await clickSaveAndWait(p);
  console.log('SAVE RESULT:', JSON.stringify(saveRes));

  p.close();
  process.exit(0);
}

// ── driver helpers (run small evals against the injected toolkit) ─────────────
async function setField(p, key, value) {
  await p.evaluate(`window.__cc.setNamedField(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  await sleep(120);
}

// Insert nodes for a sequence located at `path` (array of {branch, index}).
// path=[] is the root SequenceEditor.
async function buildSeq(p, path, seq) {
  for (let i = 0; i < seq.length; i += 1) {
    const node = seq[i];
    // Insert a node of this kind at index i within the addressed sequence.
    await p.evaluate(`window.__cc.openInsertMenu(${JSON.stringify(path)}, ${i})`);
    await sleep(250);
    await p.evaluate(`window.__cc.pickInsertKind(${JSON.stringify(node.kind)})`);
    await sleep(400);
    const nodePath = [...path, i];
    if (node.kind === 'system') {
      await p.evaluate(`window.__cc.setSystem(${JSON.stringify(nodePath)}, ${JSON.stringify(node.actionKey)}, ${JSON.stringify(node.name || '')})`);
      await sleep(200);
    } else if (node.kind === 'task') {
      await p.evaluate(`window.__cc.setTaskName(${JSON.stringify(nodePath)}, ${JSON.stringify(node.name || '')})`);
      await sleep(150);
      await p.evaluate(`window.__cc.setTaskAssignee(${JSON.stringify(nodePath)}, ${JSON.stringify(EMP_ID)})`);
      await sleep(150);
      // Actions: first row exists by default; add extras one at a time (React
      // state updates async, so drive the add loop from here with waits).
      let have = await p.evaluate(`window.__cc.actionRowCount(${JSON.stringify(nodePath)})`);
      while (have < node.actions.length) {
        await p.evaluate(`window.__cc.addActionRow(${JSON.stringify(nodePath)})`);
        await sleep(250);
        have = await p.evaluate(`window.__cc.actionRowCount(${JSON.stringify(nodePath)})`);
      }
      for (let a = 0; a < node.actions.length; a += 1) {
        await p.evaluate(`window.__cc.setAction(${JSON.stringify(nodePath)}, ${a}, ${JSON.stringify(node.actions[a].actionKey)}, ${JSON.stringify(node.actions[a].label || '')})`);
        await sleep(150);
      }
    } else if (node.kind === 'condition') {
      await p.evaluate(`window.__cc.setCondition(${JSON.stringify(nodePath)}, ${JSON.stringify(node.conditionKey)})`);
      await sleep(250);
      // Recurse into TRUE then FALSE branches.
      await buildSeq(p, [...nodePath, 'ifTrue'], node.ifTrue);
      await buildSeq(p, [...nodePath, 'ifFalse'], node.ifFalse);
    }
  }
}

async function clickSaveAndWait(p) {
  await p.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(b => /Save workflow/.test(b.textContent));
    b.click(); return true;
  })()`);
  // Poll for the saved banner or an error banner.
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const st = await p.evaluate(`(() => {
      const saved = [...document.querySelectorAll('div')].find(d => /Saved — version/.test(d.textContent) && d.textContent.length < 200);
      const err = [...document.querySelectorAll('div')].find(d => /Fix these before saving|validation failed|Workflow validation/.test(d.textContent) && d.textContent.length < 500);
      const idline = [...document.querySelectorAll('p, span')].map(e=>e.textContent.trim()).find(t=>/^cc-\\d+$/.test(t));
      return { saved: saved ? saved.textContent.trim().slice(0,120) : null, err: err ? err.textContent.trim().slice(0,300) : null, id: idline || null };
    })()`);
    if (st.saved) return { ok: true, ...st };
    if (st.err) return { ok: false, ...st };
  }
  return { ok: false, err: 'timeout waiting for save result' };
}

// ── in-page toolkit ───────────────────────────────────────────────────────────
export const TOOLKIT = `
window.__cc = (() => {
  function setReactValue(el, value) {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Named top-level fields by placeholder text.
  function setNamedField(key, value) {
    const map = {
      name: 'e.g. "HHAH Intake',
      description: 'What this workflow does',
    };
    const ph = map[key];
    const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').startsWith(ph));
    if (!el) throw new Error('field not found: ' + key);
    setReactValue(el, value);
    return true;
  }

  function pickTrigger(labelStart) {
    const labels = [...document.querySelectorAll('label')].filter(l => l.querySelector('input[type=radio][name=trigger]'));
    const lab = labels.find(l => l.textContent.trim().startsWith(labelStart));
    if (!lab) throw new Error('trigger not found: ' + labelStart);
    lab.querySelector('input[type=radio]').click();
    return true;
  }

  // The Flow card is the container that holds the START cap + root SequenceEditor.
  function flowRoot() {
    const start = [...document.querySelectorAll('div')].find(d => /^START ·/.test(d.textContent.trim()) && d.querySelectorAll('*').length < 4);
    // The SequenceEditor is the sibling flex column right after the START cap.
    // The START cap and END cap wrap the sequence in the same parent (max-w-2xl).
    return start ? start.parentElement : null;
  }

  // A "sequence container" is a flex-col element that directly holds InsertPoints
  // (buttons title="Insert a node here") and NodeShell cards as children.
  // Root sequence: the max-w-2xl wrapper's inner flex col.
  // Branch sequences: inside a condition card's TRUE/FALSE panel.

  // Return the DOM element for the sequence addressed by path.
  // path = [] -> root; else a list where numbers pick the Nth node card in the
  // current sequence and 'ifTrue'/'ifFalse' descend into that condition's branch.
  function seqElFromPath(path) {
    let container = rootSeqEl();
    let k = 0;
    while (k < path.length) {
      const seg = path[k];
      // A branch descent is always a (number, branch-name) pair.
      if (typeof seg === 'number') {
        const branch = path[k + 1];
        if (branch !== 'ifTrue' && branch !== 'ifFalse') {
          throw new Error('expected branch after index in path ' + JSON.stringify(path));
        }
        const card = nodeCards(container)[seg];
        if (!card) throw new Error('no node card at index ' + seg + ' path ' + JSON.stringify(path));
        container = branchSeqEl(card, branch);
        k += 2;
      } else {
        throw new Error('unexpected path segment ' + JSON.stringify(seg));
      }
    }
    return container;
  }

  function rootSeqEl() {
    // The wrapper div.max-w-2xl contains START cap, the SequenceEditor flex col, END cap.
    const wrap = [...document.querySelectorAll('div.max-w-2xl')].find(w => /START ·/.test(w.textContent) && /END/.test(w.textContent));
    if (!wrap) throw new Error('flow wrapper not found');
    // The SequenceEditor is the flex.flex-col.items-center child (or the empty-state one).
    const cols = [...wrap.children].filter(c => c.className && c.className.includes('flex') && c.className.includes('col'));
    // Prefer the one containing insert points.
    const seqCol = cols.find(c => c.querySelector('button[title="Insert a node here"]')) || cols[0];
    return seqCol || wrap;
  }

  // Direct-child node cards (NodeShell) of a sequence container. NodeShells are
  // div.rounded-xl.border-2 with a SYS/HUMAN/IF badge. They are wrapped in a
  // React.Fragment so they appear as direct children of the seq col.
  function nodeCards(container) {
    return [...container.children].filter(el =>
      el.matches && el.matches('div.rounded-xl.border-2'));
  }

  // Given a condition NodeShell card, return the TRUE or FALSE branch's inner
  // SequenceEditor container.
  function branchSeqEl(card, which) {
    // The condition card renders a grid with two panels. TRUE panel border-emerald,
    // FALSE panel border-slate. Each panel contains a SequenceEditor flex col.
    const truePanel = card.querySelector('div.border-emerald-200');
    const falsePanel = [...card.querySelectorAll('div')].find(d =>
      d.className && d.className.includes('border-slate-200') && d.className.includes('bg-slate-50'));
    const panel = which === 'ifTrue' ? truePanel : falsePanel;
    if (!panel) throw new Error('branch panel not found: ' + which);
    const seqCol = [...panel.querySelectorAll('div')].find(d =>
      d.className && d.className.includes('flex') && d.className.includes('col') &&
      (d.querySelector('button[title="Insert a node here"]')));
    return seqCol || panel;
  }

  // Insert a node of kind at position idx within the addressed sequence.
  // InsertPoints: there are seq.length+1 of them (before each node + at end).
  // We click the idx-th insert point, then the kind item in the popover.
  function openInsertMenu(path, idx) {
    const container = seqElFromPath(path);
    const points = directInsertPoints(container);
    const point = points[idx];
    if (!point) throw new Error('no insert point idx ' + idx + ' (have ' + points.length + ') path ' + JSON.stringify(path));
    // Mark this point so the follow-up pick can find its popover.
    [...document.querySelectorAll('[data-cc-active-ip]')].forEach(e => e.removeAttribute('data-cc-active-ip'));
    point.setAttribute('data-cc-active-ip', '1');
    point.querySelector('button[title="Insert a node here"]').click();
    return true;
  }
  function pickInsertKind(kind) {
    const labelMap = { system: 'System action', task: 'Task (human)', condition: 'Condition (if / else)' };
    const want = labelMap[kind];
    const point = document.querySelector('[data-cc-active-ip]');
    const scope = point || document;
    const btn = [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === want)
      || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === want);
    if (!btn) throw new Error('insert menu item not found: ' + want);
    btn.click();
    if (point) point.removeAttribute('data-cc-active-ip');
    return true;
  }

  // Insert points that belong directly to this sequence (not to nested branch
  // sequences inside condition cards in this sequence).
  function directInsertPoints(container) {
    const all = [...container.children];
    return all.filter(el => el.matches && el.matches('div.relative.flex.flex-col.items-center'));
  }

  function cardAt(path) {
    // path ends in a number -> the node card; descend branches for prefixes.
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const container = seqElFromPath(parentPath);
    const card = nodeCards(container)[idx];
    if (!card) throw new Error('cardAt: no card ' + JSON.stringify(path));
    return card;
  }

  function setSystem(path, actionKey, name) {
    const card = cardAt(path);
    const sel = card.querySelector('select');
    setReactValue(sel, actionKey);
    if (name) {
      const nameInput = [...card.querySelectorAll('input[type=text]')][0];
      if (nameInput) setReactValue(nameInput, name);
    }
    return true;
  }

  function setTaskName(path, name) {
    const card = cardAt(path);
    const nameInput = card.querySelector('input[type=text]');
    setReactValue(nameInput, name);
    return true;
  }
  function setTaskAssignee(path, empId) {
    const card = cardAt(path);
    // The assignee select is the first select inside the task card (before action rows).
    const sel = card.querySelector('select');
    setReactValue(sel, empId);
    return true;
  }
  function actionRowEls(card) {
    // action rows: div.rounded-lg.border.border-pink-200
    return [...card.querySelectorAll('div.rounded-lg.border-pink-200')];
  }
  function actionRowCount(path) {
    return actionRowEls(cardAt(path)).length;
  }
  function addActionRow(path) {
    const card = cardAt(path);
    const addBtn = [...card.querySelectorAll('button')].find(b => /Add action/.test(b.textContent));
    if (!addBtn) throw new Error('Add action button not found');
    addBtn.click();
    return true;
  }
  function setAction(path, aIdx, actionKey, label) {
    const card = cardAt(path);
    const rows = actionRowEls(card);
    const row = rows[aIdx];
    if (!row) throw new Error('no action row ' + aIdx);
    const sel = row.querySelector('select');
    setReactValue(sel, actionKey);
    if (label) {
      const inp = row.querySelector('input[type=text]');
      if (inp) setReactValue(inp, label);
    }
    return true;
  }

  function setCondition(path, condKey) {
    const card = cardAt(path);
    const sel = card.querySelector('select');
    setReactValue(sel, condKey);
    return true;
  }

  function summary() {
    const root = rootSeqEl();
    const countAll = (kind) => document.querySelectorAll('span').length; // noop
    return {
      rootCards: nodeCards(root).length,
      totalSys: [...document.querySelectorAll('span')].filter(s => s.textContent.trim()==='SYS').length,
      totalHuman: [...document.querySelectorAll('span')].filter(s => s.textContent.trim()==='HUMAN').length,
      totalIf: [...document.querySelectorAll('span')].filter(s => s.textContent.trim()==='IF').length,
    };
  }

  return { setReactValue, setNamedField, pickTrigger, openInsertMenu, pickInsertKind, setSystem, setTaskName,
           setTaskAssignee, actionRowCount, addActionRow, setAction, setCondition, summary,
           rootSeqEl, nodeCards, seqElFromPath };
})();
true;
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('DRIVER ERROR:', e.message || e); process.exit(1); });
}
