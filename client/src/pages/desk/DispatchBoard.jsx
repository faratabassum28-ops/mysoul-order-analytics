import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { duration, fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { AssigneeRow, Empty, MultiPhotoField, OrderDrawer, PayTag, WhoFilter, Workload, notifyDesk, peopleFor, useAssign, useClock, useDebounced, useLabels, useTeam } from './shared.jsx';

// The three columns of the Dispatch queue, left to right. "done" is the button label on the card.
const COLS = [
  { key: 'slip', label: 'stepSlip', hint: () => 'Print the slip and stick it on the box.' },
  { key: 'packed', label: 'stepPacked', hint: (L) => `Pack the box. ${L('btnDone')} asks for photos of the package. The AWB comes from Shipway.` },
  { key: 'handover', label: 'stepHandover', hint: (L) => `Create a manifest per courier, then hand over each manifest group with one photo.` },
];
const hm = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const whenLabel = (conf) => (conf.dayOffset === 0 ? `Working day ${hm(conf.dueTime)}` : `${conf.dayOffset} working day${conf.dayOffset === 1 ? '' : 's'} later, ${hm(conf.dueTime)}`);

// "Due Mon 12:00 PM · in 2h 10m" / "Overdue 1h 05m"
function Due({ dueAt, now, offset }) {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - (now + offset);
  const when = new Date(dueAt).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  if (ms >= 0) return <span className="sd-due wait" title={`Due ${fmtWhen(dueAt)}`}>{when} · in {duration(ms)}</span>;
  return <span className="sd-due late" title={`Was due ${fmtWhen(dueAt)}`}>Overdue {duration(-ms)}</span>;
}

function Card({ o, col, title, now, offset, canAct, busy, picked, onPick, onDone, onHold, onCancel, onOpen, assign }) {
  const { L } = useLabels();
  const late = o.dq.dueAt && new Date(o.dq.dueAt).getTime() < now + offset;
  const awb = col.key === 'packed' ? o.dq.suggestedAwb : col.key === 'handover' && o.dq.packed ? o.dq.packed.awb : '';
  const courier = col.key === 'packed' ? o.dq.suggestedCourier : col.key === 'handover' && o.dq.packed ? o.dq.packed.courier : '';
  return (
    <article className={`sd-card dispatch dq-card ${late ? 'late' : ''}`} aria-label={`${o.orderName}, ${title}`}>
      <header>
        <div className="sd-id">
          {col.key === 'handover' && canAct && <input type="checkbox" className="dq-pick" checked={picked} onChange={() => onPick(o.orderId)} aria-label={`Select ${o.orderName} for the manifest`} />}
          <button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button>
          <PayTag o={o} />{o.partial && <span className="sd-pay part">{L('payPartial')}</span>}
        </div>
        <Due dueAt={o.dq.dueAt} now={now} offset={offset} />
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
      <div className="sd-line"><span className="sd-amt">{inr(o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      {col.key !== 'slip' && (awb ? <div className="sd-foot"><span>AWB <b>{awb}</b>{courier ? ` · ${courier}` : ''}</span></div> : <div className="sd-foot warn"><span>AWB not in Shipway yet</span></div>)}
      {col.key === 'handover' && o.dq.manifestError && <div className="sd-foot warn" role="alert"><span>Shipway rejected it for the manifest: <b>{o.dq.manifestError.message}</b></span></div>}
      {o.collect > 0 && Math.round(o.collect) !== Math.round(o.total || 0) && <div className="sd-foot"><span className="sd-collect-tag">Collect {inr(o.collect)}</span></div>}
      {(assign || canAct) && (
        <div className="dq-row">
          {assign && <AssigneeRow o={o} {...assign} />}
          {canAct && <button className="btn good dq-done" disabled={busy} onClick={() => onDone(o, col.key)}>{L('btnDone')}</button>}
        </div>
      )}
      {canAct && (
        <div className="dq-row dq-side">
          <button className="btn ghost dq-hold" disabled={busy} onClick={() => onHold(o)}>⏸ Hold</button>
          <button className="btn ghost dq-cancel" disabled={busy} onClick={() => onCancel(o)}>Cancel order</button>
        </div>
      )}
    </article>
  );
}

// A card in the "On hold" section: why it is held, who held it, and the way out (Resume or Cancel).
function HeldCard({ o, now, offset, canAct, busy, onResume, onCancel, onOpen }) {
  const { L } = useLabels();
  const h = o.dq.hold;
  const ms = now + offset - new Date(h.at).getTime();
  return (
    <article className="sd-card dispatch dq-card held" aria-label={`${o.orderName}, on hold`}>
      <header>
        <div className="sd-id"><button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button><PayTag o={o} />{o.partial && <span className="sd-pay part">{L('payPartial')}</span>}</div>
        <span className="sd-due wait" title={`On hold since ${fmtWhen(h.at)}`}>On hold {duration(Math.max(0, ms))}</span>
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
      <div className="sd-line"><span className="sd-amt">{inr(o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      <div className="dq-note"><b>Note</b> “{h.note}”<span className="muted"> · {h.byName}, {fmtWhen(h.at)} · was at {L(STEP_KEYS[h.step] || 'stepSlip')}</span></div>
      {canAct && (
        <div className="dq-row dq-side">
          <button className="btn good dq-resume" disabled={busy} onClick={() => onResume(o)}>▶ Resume</button>
          <button className="btn ghost dq-cancel" disabled={busy} onClick={() => onCancel(o)}>Cancel order</button>
        </div>
      )}
    </article>
  );
}
const STEP_KEYS = { slip: 'stepSlip', packed: 'stepPacked', handover: 'stepHandover' };

// ---------------------------------------------------------------- hold and cancel forms
function HoldSheet({ order: o, show, onClose, onDone }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api.post(`/desk/dispatch/${o.orderId}/hold`, { note: note.trim() }); notifyDesk(); show(`${o.orderName} is on hold. Its deadline is paused.`); onDone(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`Put on hold · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)}. The order stays at its step but moves to “On hold”, and its deadline stops until someone resumes it.</p>
      <label className="sheet-label" htmlFor="hold-note">Why is it on hold? (required)</label>
      <textarea id="hold-note" className="sd-text" rows={3} maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: customer asked to change the address; item out of stock" />
      <button className="btn big good" disabled={busy || note.trim().length < 3} onClick={submit}>{busy ? 'Saving…' : note.trim().length < 3 ? 'Write a note to put on hold' : 'Put on hold'}</button>
    </Sheet>
  );
}

function ResumeSheet({ order: o, show, onClose, onDone }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api.post(`/desk/dispatch/${o.orderId}/resume`, { note: note.trim() }); notifyDesk(); show(`${o.orderName} resumed. Its deadline starts again now.`); onDone(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`Resume · ${o.orderName}`} onClose={onClose}>
      <p className="muted">Held for: “{o.dq.hold.note}”. After resuming it goes back to its column and the deadline counts from now.</p>
      <label className="sheet-label" htmlFor="resume-note">Note (optional)</label>
      <textarea id="resume-note" className="sd-text" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the next person should know" />
      <button className="btn big good" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Resume order'}</button>
    </Sheet>
  );
}

function CancelSheet({ order: o, reasons, show, onClose, onDone }) {
  const [pick, setPick] = useState(''); const [typed, setTyped] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const other = pick === 'Other';
  const reason = other ? typed.trim() : pick;
  const ok = reason.length >= 2 && note.trim().length >= 3;
  const submit = async () => {
    setBusy(true);
    try { await api.post(`/desk/dispatch/${o.orderId}/cancel`, { reason, note: note.trim() }); notifyDesk(); show(`${o.orderName} cancelled.`); onDone(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`Cancel order · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)}. The order leaves the dispatch queue and goes to Cancelled.{o.partial ? ` ${inr(o.partial.amount)} was already received: a refund will show as due.` : ''}</p>
      <p className="sd-q">Why is {o.orderName} being cancelled?</p>
      <div className="reasons" role="radiogroup" aria-label="Cancellation reason">
        {reasons.map((r) => <button key={r} role="radio" aria-checked={pick === r} className={`reason-opt ${pick === r ? 'on' : ''}`} onClick={() => setPick(r)}>{r}</button>)}
        {!reasons.includes('Other') && <button role="radio" aria-checked={other} className={`reason-opt ${other ? 'on' : ''}`} onClick={() => setPick('Other')}>Other</button>}
      </div>
      {other && <input type="text" placeholder="Type the reason" value={typed} maxLength={120} onChange={(e) => setTyped(e.target.value)} autoFocus />}
      <label className="sheet-label" htmlFor="dc-note">Note (required)</label>
      <textarea id="dc-note" className="sd-text" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? The next person will read this" />
      <button className="btn big danger" disabled={busy || !ok} onClick={submit}>{busy ? 'Saving…' : !reason ? 'Choose a reason' : note.trim().length < 3 ? 'Write a note to cancel' : 'Cancel this order'}</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- forms
// Order packed: the AWB and courier are read from Shipway and shown, not typed. No photos are needed.
function PackedSheet({ order: o, conf, show, onClose, onDone }) {
  const { L } = useLabels();
  const [live, setLive] = useState({ awb: o.dq.suggestedAwb || '', courier: o.dq.suggestedCourier || '', looking: true, allowManual: !!conf.allowManualAwb, shipwayConfigured: true });
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const look = async () => { // ask Shipway again right now: the label may have been made a minute ago
    setLive((x) => ({ ...x, looking: true }));
    try { const r = await api.get(`/desk/dispatch/${o.orderId}/awb`); setLive({ awb: r.awb || '', courier: r.courier || '', looking: false, allowManual: r.allowManual, shipwayConfigured: r.shipwayConfigured }); }
    catch { setLive((x) => ({ ...x, looking: false })); }
  };
  useEffect(() => { look(); }, [o.orderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const awb = live.awb || (live.allowManual ? manual : '');
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      if (!live.awb) fd.append('awb', manual); // only used when Shipway has none
      await api.upload(`/desk/dispatch/${o.orderId}/packed`, fd);
      notifyDesk(); show(`${o.orderName} packed. It is now in ${L('stepHandover')}.`); onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409 && !/AWB/.test(e.message)) onDone(); } finally { setBusy(false); }
  };
  const ready = awb.replace(/\s/g, '').length >= 5;
  return (
    <Sheet title={`${L('stepPacked')} · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)}</p>
      <div className="awb-box">
        <div><span>AWB number</span><b>{live.awb || (live.looking ? 'Checking Shipway…' : '—')}</b></div>
        <div><span>Courier</span><b>{live.courier || (live.looking ? '' : '—')}</b></div>
        <small className="muted">{live.awb ? 'Filled from Shipway. Nothing to type.' : live.looking ? 'Asking Shipway for this order…' : !live.shipwayConfigured ? 'Shipway is not connected on the server.' : 'Shipway has no AWB for this order yet.'}</small>
        {!live.awb && !live.looking && <button className="btn ghost" onClick={look}>Fetch from Shipway again</button>}
      </div>
      {!live.awb && !live.looking && (live.allowManual
        ? <><label className="sheet-label" htmlFor="pk-awb">Type the AWB from the label (only because Shipway has none yet)</label><input id="pk-awb" type="text" autoCapitalize="characters" autoComplete="off" maxLength={40} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="AWB number" /></>
        : <div className="banner">Wait for the shipment to be created in Shipway, then press “Fetch from Shipway again”.</div>)}
      <button className="btn big good" disabled={busy || !ready} onClick={submit}>{busy ? 'Saving…' : !awb.trim() ? 'Waiting for the AWB from Shipway' : `Save: ${L('stepPacked').toLowerCase()}`}</button>
    </Sheet>
  );
}

// Order handover: photos of the manifest. One manifest can cover several orders.
function HandoverSheet({ orders, manifest, conf, show, onClose, onDone }) {
  const { L } = useLabels();
  const [files, setFiles] = useState([]); const [busy, setBusy] = useState(false);
  const courier = useMemo(() => { const c = [...new Set(orders.map((o) => (o.dq.packed && o.dq.packed.courier) || '').filter(Boolean))]; return c.length === 1 ? c[0] : ''; }, [orders]);
  const need = conf.stages.handover.requirePhoto;
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('orderIds', JSON.stringify(orders.map((o) => o.orderId))); fd.append('courier', courier); if (manifest) fd.append('manifestId', manifest); files.forEach((f) => fd.append('manifests', f));
      const r = await api.upload('/desk/dispatch/handover', fd);
      notifyDesk();
      if (r.failed && r.failed.length) show(`${r.done.length} handed over. ${r.failed.length} could not be saved: ${r.failed.map((f) => `#${f.orderId}`).join(', ')}.`, 'err');
      else show(`${r.done.length === 1 ? orders[0].orderName : `${r.done.length} orders`} handed over. See ${L('tabTransit')}.`);
      onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={manifest ? `${L('stepHandover')} · manifest ${manifest}` : orders.length === 1 ? `${L('stepHandover')} · ${orders[0].orderName}` : `${L('stepHandover')} · ${orders.length} orders`} onClose={onClose}>
      {manifest && <p className="muted">One photo of the manifest hands over all {orders.length} {orders.length === 1 ? 'order' : 'orders'} below.</p>}
      <ul className="dq-list">{orders.map((o) => <li key={o.orderId}><b>{o.orderName}</b><span>{o.dq.packed ? `AWB ${o.dq.packed.awb}` : ''}</span></li>)}</ul>
      <MultiPhotoField label="Photos of the manifest" files={files} setFiles={setFiles} required={need} />
      <p className="muted">After this the {orders.length === 1 ? 'order moves' : 'orders move'} to {L('tabTransit')}, where Shipway tracking is fetched.</p>
      <button className="btn big good" disabled={busy || (need && !files.length)} onClick={submit}>{busy ? 'Saving…' : need && !files.length ? 'Add a manifest photo to save' : 'Save: handed over'}</button>
    </Sheet>
  );
}

// Create manifest: pick a courier, one tap creates the manifest in Shipway for every packed order of that courier.
function ManifestSheet({ couriers, names, show, onClose, onDone }) {
  const [courier, setCourier] = useState(couriers.length === 1 ? couriers[0].courier : '');
  const pick = couriers.find((c) => c.courier === courier);
  const [ticked, setTicked] = useState(() => new Set(couriers.length === 1 ? couriers[0].orders.map((o) => o.orderId) : []));
  const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const choose = (c) => { setCourier(c.courier); setTicked(new Set(c.orders.map((o) => o.orderId))); }; // everything starts ticked; untick what is not packed
  const flip = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = pick ? pick.orders.every((o) => ticked.has(o.orderId)) : false;
  const n = pick ? pick.orders.filter((o) => ticked.has(o.orderId)).length : 0;
  const submit = async () => {
    setBusy(true);
    try { const r = await api.post('/desk/dispatch/manifest', { courier, orderIds: pick.orders.filter((o) => ticked.has(o.orderId)).map((o) => o.orderId) }); notifyDesk(); setRes(r); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  if (res) {
    const bad = [...res.rejected, ...(res.failed || []), ...(res.skipped || [])];
    return (
      <Sheet title={res.manifestId ? `Manifest ${res.manifestId} created` : 'No manifest created'} onClose={onDone}>
        {res.manifestId
          ? <p>{res.created.length} {res.created.length === 1 ? 'order is' : 'orders are'} on manifest <b>{res.manifestId}</b> ({res.courier}). Find the group in Order handover and add one photo.</p>
          : res.noId
            ? <div className="banner warn"><b>Shipway said: “{res.shipwayMessage}”</b> but it did not send a manifest ID the app can read, so no order was grouped. The manifest may now exist in Shipway, so do not press Create manifest again for these orders. Send the details below to support.</div>
            : <div className="banner">Shipway did not create a manifest, so no order was grouped.</div>}
        {res.rawReply && <details><summary className="muted">Details for support</summary><pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{res.rawReply}</pre></details>}
        {bad.length > 0 && <>
          <p className="sd-q">{bad.length} {bad.length === 1 ? 'order was' : 'orders were'} left out:</p>
          <ul className="dq-list">{bad.map((r) => <li key={r.orderId}><b>#{r.orderId}</b><span>{r.reason}</span></li>)}</ul>
          <p className="muted">They stay in Order handover, outside the group, with this reason on the card. Fix the cause, then create a manifest again.</p>
        </>}
        {res.leftOver > 0 && <p className="muted">{res.leftOver} more {res.leftOver === 1 ? 'order is' : 'orders are'} still waiting (at most 50 go on one manifest). Create another manifest for them.</p>}
        <button className="btn big good" onClick={onDone}>Done</button>
      </Sheet>
    );
  }
  return (
    <Sheet title="Create manifest" onClose={onClose}>
      <p className="muted">Pick the courier, then tick only the orders that are really packed and ready. Unticked orders stay waiting and are not sent to Shipway. Shipway may still refuse some; those are left out and the reason is shown.</p>
      {!couriers.length && <div className="banner warn">No packed orders with a courier name are waiting for a manifest.</div>}
      <p className="sd-q">Which courier?</p>
      <div className="reasons" role="radiogroup" aria-label="Courier">
        {couriers.map((c) => <button key={c.courier} role="radio" aria-checked={courier === c.courier} className={`reason-opt ${courier === c.courier ? 'on' : ''}`} onClick={() => choose(c)}>{c.courier} · {c.count}</button>)}
      </div>
      {pick && <>
        <p className="sd-q">Which orders are packed? <button className="link" onClick={() => setTicked(all ? new Set() : new Set(pick.orders.map((o) => o.orderId)))}>{all ? 'Untick all' : 'Tick all'}</button></p>
        <ul className="dq-list" aria-label="Orders to put on the manifest">
          {pick.orders.map((o) => (
            <li key={o.orderId}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', cursor: 'pointer' }}>
                <input type="checkbox" checked={ticked.has(o.orderId)} onChange={() => flip(o.orderId)} />
                <b>{names[o.orderId] || `#${o.orderId}`}</b><span>AWB {o.awb || '—'}</span>
              </label>
            </li>
          ))}
        </ul>
      </>}
      <button className="btn big good" disabled={busy || !pick || n === 0} onClick={submit}>{busy ? 'Asking Shipway…' : !pick ? 'Pick a courier' : n === 0 ? 'Tick at least one order' : `Create manifest for ${n} ticked ${n === 1 ? 'order' : 'orders'}`}</button>
    </Sheet>
  );
}

// One group per manifest id: the order ids with their AWBs, and one photo for the whole group.
function ManifestGroup({ g, canAct, onHand, onOpen }) {
  return (
    <article className="sd-card dispatch dq-card manifest-group" aria-label={`Manifest ${g.manifestId}`}>
      <header>
        <div className="sd-id"><b>Manifest {g.manifestId}</b></div>
        <span className="sd-due wait">{g.orders.length} {g.orders.length === 1 ? 'order' : 'orders'}{g.courier ? ` · ${g.courier}` : ''}</span>
      </header>
      <ul className="dq-list">
        {g.orders.map((o) => <li key={o.orderId}><button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button><span>AWB {(o.dq.packed && o.dq.packed.awb) || '—'}</span></li>)}
      </ul>
      {g.byName && <small className="muted">Created by {g.byName}{g.at ? `, ${fmtWhen(g.at)}` : ''}</small>}
      {canAct && <div className="dq-row"><button className="btn good dq-done" onClick={() => onHand(g)}>Hand over manifest (1 photo)</button></div>}
    </article>
  );
}

// ---------------------------------------------------------------- page
export default function DispatchBoard() {
  const { user } = useStaff();
  const { L } = useLabels();
  const actor = can(user, 'packing');
  const isAdmin = user.role === 'admin';
  const team = useTeam(); const people = peopleFor(team, 'dispatch');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [who, setWho] = useState('');
  const { data, error, loading, reload } = useApi('/desk/dispatch/board', { q: qd, assignee: who });
  useAutoRefresh(reload, 20);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [toast, show] = useToast();
  const [open, setOpen] = useState(null);
  const assign = useAssign({ reload, show });
  const [packing, setPacking] = useState(null); const [handing, setHanding] = useState(null); const [handingManifest, setHandingManifest] = useState(null); const [making, setMaking] = useState(false);
  const [holding, setHolding] = useState(null); const [resuming, setResuming] = useState(null); const [cancelling, setCancelling] = useState(null);
  const [picked, setPicked] = useState([]); const [busyId, setBusyId] = useState(null);
  const conf = data && data.config;
  const c = data && data.counts;
  const handoverAll = data ? data.columns.handover : [];
  const looseIds = data ? new Set(data.looseHandover || handoverAll.map((o) => o.orderId)) : new Set();
  const handover = handoverAll.filter((o) => looseIds.has(o.orderId)); // only orders without a manifest are picked one by one
  useEffect(() => { setPicked((p) => p.filter((id) => handover.some((o) => o.orderId === id))); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const done = async (o, key) => {
    if (key === 'packed') return setPacking(o);
    if (key === 'handover') return setHanding([o]);
    setBusyId(o.orderId);
    try { await api.post(`/desk/dispatch/${o.orderId}/slip`); notifyDesk(); show(`${o.orderName}: packing slip done. It is now in Order packed.`); reload(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) reload(); } finally { setBusyId(null); }
  };
  const finish = (setter) => () => { setter(null); setHandingManifest(null); setPicked([]); reload(); };
  const held = data ? data.hold || [] : [];

  return (
    <section>
      <div className="dq-head">
        <p className="sd-hint">Confirmed orders land in Packing slip. Press {L('btnDone')} on a card to move it to the next column; each column has its own deadline.</p>
        {user.role === 'admin' && <Link className="btn ghost" to="/shopify-desk/settings#dispatch">⚙ Dispatch settings</Link>}
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" />
        <WhoFilter value={who} onChange={setWho} people={isAdmin ? people : []} show={!!data && (Object.values(data.assign.modes).some((m) => m !== 'off') || !!who)} />
        {data && <span className="muted">{data.shown} {data.shown === 1 ? 'order' : 'orders'}{c && c.overdue ? ` · ${c.overdue} overdue` : ''}{held.length ? ` · ${held.length} on hold` : ''}{data.collectTotal ? ` · ${inr(data.collectTotal)} to collect on delivery` : ''}</span>}</div>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <div className="dq-board">
            {COLS.map((col) => {
              const items = col.key === 'handover' ? handover : data.columns[col.key];
              const groups = col.key === 'handover' ? data.manifests || [] : [];
              const st = conf.stages[col.key];
              return (
                <div key={col.key} className={`dq-col ${col.key}`}>
                  <div className="dq-colhead">
                    <div className="dq-title"><h2>{L(col.label)}</h2><span className={`sd-count ${c.overdueBy[col.key] ? 'hot' : ''}`} title={c.overdueBy[col.key] ? `${c.overdueBy[col.key]} overdue` : ''}>{col.key === 'handover' ? handoverAll.length : items.length}</span>
                      {user.role === 'admin' && <Link className="dq-gear" to="/shopify-desk/settings#dispatch" title={`${L(col.label)} settings`} aria-label={`${L(col.label)} settings`}>⚙</Link>}</div>
                    <span className="dq-when">{whenLabel(st)}</span>
                    <small>{col.hint(L)}</small>
                    {data.assign.modes[col.key] !== 'off' && <span className="dq-when asg">{data.assign.modes[col.key] === 'auto' ? 'Shared out automatically' : 'Assigned by an admin'}</span>}
                    {data.assign.modes[col.key] !== 'off' && isAdmin && <Workload items={items} />}
                    {col.key === 'handover' && actor && (items.length > 0 || (data.manifestCouriers || []).length > 0) && (
                      <div className="dq-bulk"><button className="btn good" onClick={() => setMaking(true)}>Create manifest for all packed orders</button></div>
                    )}
                    {col.key === 'handover' && actor && items.length > 0 && (
                      <div className="dq-bulk">
                        <button className="btn ghost" onClick={() => setPicked(picked.length === items.length ? [] : items.map((o) => o.orderId))}>{picked.length === items.length ? 'Clear' : 'Select all'}</button>
                        <button className="btn good" disabled={!picked.length} onClick={() => setHanding(items.filter((o) => picked.includes(o.orderId)))}>Hand over selected ({picked.length})</button>
                      </div>
                    )}
                  </div>
                  <div className="dq-cards">
                    {groups.map((g) => <ManifestGroup key={g.manifestId} g={g} canAct={actor} onHand={(grp) => { setHandingManifest(grp.manifestId); setHanding(grp.orders); }} onOpen={setOpen} />)}
                    {groups.length > 0 && items.length > 0 && <p className="sd-hint">Not on a manifest yet:</p>}
                    {items.length === 0 && groups.length > 0 ? null : items.length === 0
                      ? <Empty title="Nothing here">{col.key === 'slip' ? (q ? 'No orders match this search.' : 'Confirmed orders appear here the moment someone taps Confirmed.') : 'Cards arrive here when DONE is pressed in the column before.'}</Empty>
                      : items.map((o) => <Card key={o.orderId} o={o} col={col} title={L(col.label)} assign={data.assign.modes[col.key] !== 'off' ? { mode: data.assign.modes[col.key], isAdmin, me: user.id, people, onAssign: assign } : null} now={now} offset={offset} canAct={actor} busy={busyId === o.orderId} picked={picked.includes(o.orderId)} onPick={pick} onDone={done} onHold={setHolding} onCancel={setCancelling} onOpen={setOpen} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {data && held.length > 0 && (
          <div className="dq-col hold dq-holdbox">
            <div className="dq-colhead">
              <div className="dq-title"><h2>On hold</h2><span className="sd-count">{held.length}</span></div>
              <small>Paused orders. Their deadline is stopped. Resume to send one back to its column, or cancel it. Every hold and cancel needs a note.</small>
            </div>
            <div className="dq-cards dq-holdcards">
              {held.filter((o) => o.dq && o.dq.hold).map((o) => <HeldCard key={o.orderId} o={o} now={now} offset={offset} canAct={actor} busy={busyId === o.orderId} onResume={setResuming} onCancel={setCancelling} onOpen={setOpen} />)}
            </div>
          </div>
        )}
      </Loading>
      {holding && <HoldSheet order={holding} show={show} onClose={() => setHolding(null)} onDone={finish(setHolding)} />}
      {resuming && <ResumeSheet order={resuming} show={show} onClose={() => setResuming(null)} onDone={finish(setResuming)} />}
      {cancelling && <CancelSheet order={cancelling} reasons={(data && data.cancelReasons) || []} show={show} onClose={() => setCancelling(null)} onDone={finish(setCancelling)} />}
      {packing && <PackedSheet order={packing} conf={conf} show={show} onClose={() => setPacking(null)} onDone={finish(setPacking)} />}
      {making && <ManifestSheet couriers={data.manifestCouriers || []} names={Object.fromEntries(handoverAll.map((o) => [o.orderId, o.orderName]))} show={show} onClose={() => setMaking(false)} onDone={() => { setMaking(false); reload(); }} />}
      {handing && <HandoverSheet orders={handing} manifest={handingManifest} conf={conf} show={show} onClose={() => { setHanding(null); setHandingManifest(null); }} onDone={finish(setHanding)} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </section>
  );
}
