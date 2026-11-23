#!/usr/bin/env python3
"""Served dashboard over the rule-hit ledger. Thin layer over report.aggregate."""
from __future__ import annotations

import argparse
import json
import mimetypes
from pathlib import Path
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server

import lib
import ledger
import paths
import report

VENDOR = Path(__file__).resolve().parent / "vendor"

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>KB hit-ledger</title>
<script src="/static/chart.umd.min.js"></script>
<style>
 :root{
   --bg:#f4f5f7; --surface:#ffffff; --fg:#1b1e23; --muted:#6b7280; --border:#e4e6ea;
   --accent:#2563eb; --accent-fg:#ffffff; --warn:#b45f06; --warn-bg:#fff6e8;
   --fail:#f43f5e; --pass:#22c55e; --radius:12px;
   --shadow:0 1px 2px rgba(16,24,40,.04),0 4px 10px rgba(16,24,40,.05);
 }
 *{box-sizing:border-box}
 body{
   font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
   margin:0;background:var(--bg);color:var(--fg);
 }
 .wrap{max-width:1120px;margin:0 auto;padding:32px 24px 64px}
 header.top{margin-bottom:20px}
 header.top h2{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
 header.top p{margin:0;color:var(--muted);font-size:13px}

 .toolbar{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
   box-shadow:var(--shadow);padding:14px 18px;margin-bottom:20px;
   display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
 .field{display:flex;flex-direction:column;gap:4px;font-size:13px}
 .field span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
 .field input,.field select{font:inherit;padding:6px 10px;border:1px solid var(--border);
   border-radius:8px;background:var(--bg);color:var(--fg);min-height:32px}
 .field input:focus,.field select:focus{outline:2px solid var(--accent);outline-offset:1px}
 .btn{font:inherit;padding:7px 16px;border-radius:8px;border:1px solid var(--border);
   background:var(--surface);cursor:pointer;color:var(--fg)}
 .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
 .btn:hover{filter:brightness(0.97)}
 #err{color:var(--fail);font-size:13px}

 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:16px}
 .card{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);
   border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
 .card span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
 .card b{display:block;font-size:28px;margin-top:2px;font-weight:650}
 .card.warn{border-left-color:var(--warn);background:var(--warn-bg)}
 .card.warn b{color:var(--warn)}

 .note{display:flex;gap:8px;color:var(--muted);font-size:13px;background:var(--surface);
   border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:24px}
 .note code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:12px}

 .tabs{display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);
   border-radius:999px;padding:4px;margin-bottom:18px;width:fit-content}
 .tab{padding:7px 16px;border:none;background:none;cursor:pointer;font:inherit;
   border-radius:999px;color:var(--muted)}
 .tab.active{background:var(--accent);color:var(--accent-fg);font-weight:600}
 .panel{display:none}
 .panel.active{display:block}

 .section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
   box-shadow:var(--shadow);padding:18px 20px;margin-bottom:20px}
 .section h3{margin:0 0 12px;font-size:15px}
 .tablebar{display:flex;justify-content:flex-end;margin-bottom:10px}
 .tablebar input{font:inherit;padding:6px 12px;border:1px solid var(--border);border-radius:999px;
   min-width:220px;background:var(--bg);color:var(--fg)}
 .tablebar input:focus{outline:2px solid var(--accent);outline-offset:1px}

 .table-wrap{max-height:56vh;overflow:auto;border:1px solid var(--border);border-radius:10px}
 table{border-collapse:collapse;width:100%;font-size:13px}
 td,th{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
 th{cursor:pointer;user-select:none;white-space:nowrap;position:sticky;top:0;
   background:var(--surface);color:var(--muted);font-weight:600;font-size:12px;
   text-transform:uppercase;letter-spacing:.03em}
 th:hover{color:var(--accent)}
 tbody tr:hover{background:var(--bg)}
 tbody tr:nth-child(even){background:rgba(0,0,0,.012)}
 td:not(:first-child),th:not(:first-child){text-align:right}
 .retired{text-decoration:line-through;color:var(--muted)}
 .sweep-only{text-decoration:line-through;color:var(--muted)}
</style></head><body>
<div class="wrap">
<header class="top">
 <h2>Knowledge-base rule hit-ledger</h2>
 <p>Local, per-machine view of check.py rule hits — gitignored data, not shared.</p>
</header>
<div class="toolbar">
 <label class="field"><span>Service</span><input id="service" placeholder="(all)" size="18"></label>
 <label class="field"><span>Source</span><select id="src"><option value="">all</option><option>skill</option>
   <option>hook</option><option>adhoc</option></select></label>
 <label class="field"><span>Since</span><input id="since" type="date" title="absolute cutoff, inclusive"></label>
 <label class="field"><span>Days</span><input id="days" type="number" min="1" size="4" style="width:5em"
   placeholder="(all)" title="relative window, N days back from now"></label>
 <button class="btn primary" onclick="load()">Apply</button>
 <button class="btn" onclick="resetFilters()">Reset</button>
 <span id="err"></span>
</div>
<div class="cards" id="cards"></div>
<p class="note">Never-fired rules are a count only — a rule can be silent because you have not
 worked in its area, which says nothing about its worth. Globs that match no file at all are a
 separate, static question: <code>validate.py</code> reports those as
 <code>unreachable_glob</code>.</p>

<div class="section">
 <h3>Activity over time</h3>
 <canvas id="dayChart" height="140"></canvas>
 <p style="color:var(--muted);font-size:13px;margin:12px 0 0">How much the check engine ran and
  how often it caught something, day by day. Runs are distinct check-engine
  runs that day; failing runs are distinct runs with at least one violation, not a raw
  violation-row count — one noisy run tripping five rules is one failing run, not five. Days
  between the first and last active day are zero-filled, so a gap reads as no activity rather
  than compressed time.</p>
</div>

<div class="section">
 <h3>Unique rules used per day</h3>
 <canvas id="ruleUsageChart" height="140"></canvas>
 <p style="color:var(--muted);font-size:13px;margin:12px 0 0">How many distinct rules were
  auto-delivered into context for an edited file on a given day. Resident rules aren't in this
  line — there's no per-day signal for them, since the resident set is a registry attribute
  read the same on every day, not an event logged when it happens. Zero-filled like the chart
  above, so a quiet day reads as 0 rather than a gap.</p>
</div>

<div class="tabs">
 <button class="tab active" data-tab="delivery" onclick="showTab('delivery')">Delivery</button>
 <button class="tab" data-tab="failures" onclick="showTab('failures')">Failures</button>
 <button class="tab" data-tab="cited" onclick="showTab('cited')">Most cited</button>
 <button class="tab" data-tab="resident" onclick="showTab('resident')">Digest-resident</button>
 <button class="tab" data-tab="retire" onclick="showTab('retire')">Retire candidates</button>
</div>

<div class="panel active" id="panel-delivery">
 <div class="section">
  <h3>Top 50 by jit_delivered</h3>
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Rules ranked by how often they
   were auto-delivered into context for a file you edited — a high count means the rule shows
   up a lot, not that it ever caught anything. A <span class="sweep-only">struck-through</span>
   fqid is <code>sweep_only</code> — still in the registry and still JIT-delivered here, but its
   check only ever runs during a review sweep, never gated on the edit itself.</p>
  <div class="tablebar"><input placeholder="filter fqid…" oninput="filterTable('jitTable',this.value)"></div>
  <div class="table-wrap"><table id="jitTable"></table></div>
 </div>
</div>

<div class="panel" id="panel-failures">
 <div class="section">
  <h3>Top 50 failures</h3>
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Rules ranked by how often they
   actually fired as a violation — this is where check.py is catching real problems in your
   changes (or, if the rate looks off, maybe firing too eagerly).</p>
  <canvas id="failChart" height="220"></canvas>
 </div>
 <div class="section">
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">A <span class="retired">struck-through</span>
   fqid no longer exists in the current rule registry — the row is historical ledger data for a
   rule that was renamed, merged, or deleted, not something you can fix by editing a rule body.</p>
  <div class="tablebar"><input placeholder="filter fqid…" oninput="filterTable('failTable',this.value)"></div>
  <div class="table-wrap"><table id="failTable"></table></div>
 </div>
</div>

<div class="panel" id="panel-cited">
 <div class="section">
  <h3>Top 20 most cited</h3>
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Rules Claude named by id as the
   actual reason behind an answer — the strongest signal a rule changed a decision, not just
   added cost to context.</p>
  <div class="tablebar"><input placeholder="filter fqid…" oninput="filterTable('citedTable',this.value)"></div>
  <div class="table-wrap"><table id="citedTable"></table></div>
 </div>
</div>

<div class="panel" id="panel-resident">
 <div class="section">
  <h3>Digest-resident rules</h3>
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Rules baked into every session's
   startup digest whether or not they're relevant that day, paired with how often each is
   actually cited — a low count here is a candidate to reconsider keeping resident.</p>
  <div class="tablebar"><input placeholder="filter fqid…" oninput="filterTable('residentTable',this.value)"></div>
  <div class="table-wrap"><table id="residentTable"></table></div>
 </div>
</div>

<div class="panel" id="panel-retire">
 <div class="section">
  <h3>Retire candidates</h3>
  <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Rules that were delivered,
   never caught a real violation, and were never cited — three conditions, not one, so a rule
   with no evidence either way (zero deliveries) stays out of this list rather than reading as
   useless. Sorted by delivery count: that's what each row costs in injected context for
   nothing shown for it.</p>
  <div class="tablebar"><input placeholder="filter fqid…" oninput="filterTable('retireTable',this.value)"></div>
  <div class="table-wrap"><table id="retireTable"></table></div>
 </div>
</div>
</div>

<script>
const CSS_VAR = getComputedStyle(document.documentElement);
const COLOR = { fail: CSS_VAR.getPropertyValue('--fail').trim(), pass: CSS_VAR.getPropertyValue('--pass').trim(),
  muted: CSS_VAR.getPropertyValue('--muted').trim(), border: CSS_VAR.getPropertyValue('--border').trim(),
  accent: CSS_VAR.getPropertyValue('--accent').trim() };
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.color = COLOR.muted;
Chart.defaults.borderColor = COLOR.border;

let charts={};
let tableData={};
function chart(id,cfg){ if(charts[id])charts[id].destroy(); charts[id]=new Chart(document.getElementById(id),cfg); }

// values are local KB fqids/counts from this user's own ledger — no untrusted input
function fmtCell(v,col,fmts){ return (fmts&&fmts[col]) ? fmts[col](v) : (v??''); }

function renderTable(id){
 const t=tableData[id]; if(!t) return;
 let data=t.data;
 if(t.filterText){
   const q=t.filterText.toLowerCase();
   data=data.filter(r=>String(r.fqid??'').toLowerCase().includes(q));
 }
 if(t.sortCol){
   const col=t.sortCol, dir=t.sortDir;
   data=data.slice().sort((a,b)=>{
     let av=a[col], bv=b[col];
     if(typeof av==='string'||typeof bv==='string'){ av=String(av??''); bv=String(bv??'');
       return dir*av.localeCompare(bv); }
     return dir*((av??0)-(bv??0));
   });
 }
 const thead="<tr>"+t.cols.map(c=>{
   const arrow=t.sortCol===c ? (t.sortDir===1?' ▲':' ▼') : '';
   return `<th onclick="sortTable('${id}','${c}')">${c}${arrow}</th>`;
 }).join("")+"</tr>";
 const tbody=data.map(r=>"<tr>"+t.cols.map(c=>{
   const v=fmtCell(r[c],c,t.formatters);
   const retired=c==='fqid'&&r.in_registry===false;
   const sweepOnly=c==='fqid'&&!retired&&r.sweep_only===true;
   let cell=v;
   if(retired) cell=`<span class="retired" title="no longer in the rule registry — historical ledger data only">${v}</span>`;
   else if(sweepOnly) cell=`<span class="sweep-only" title="sweep_only — its check only runs during a review sweep, never at edit time">${v}</span>`;
   return "<td>"+cell+"</td>";
 }).join("")+"</tr>").join("");
 document.getElementById(id).innerHTML=thead+tbody;
}
function sortTable(id,col){
 const t=tableData[id];
 if(t.sortCol===col) t.sortDir*=-1; else { t.sortCol=col; t.sortDir=-1; }
 renderTable(id);
}
function filterTable(id,text){ tableData[id].filterText=text; renderTable(id); }
function setTable(id,data,cols,formatters){
 // keep any filter text already typed into this table's box across a reload
 const prevFilter=(tableData[id]||{}).filterText||'';
 tableData[id]={data,cols,formatters:formatters||{},sortCol:null,sortDir:-1,filterText:prevFilter};
 renderTable(id);
}
function showTab(name){
 for(const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab===name);
 for(const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id==='panel-'+name);
}
function val(id){ return document.getElementById(id).value; }
function resetFilters(){
 for(const id of ['service','src','since','days']) document.getElementById(id).value='';
 load();
}
const pct=v=>v==null?'':(v*100).toFixed(2)+'%';

async function load(){
 const q=new URLSearchParams();
 for(const [id,key] of [['service','service'],['src','src'],['since','since'],['days','days']]){
   const v=val(id); if(v) q.set(key,v);
 }
 const resp=await fetch('/data.json?'+q.toString());
 const d=await resp.json();
 const err=document.getElementById('err');
 if(!resp.ok){ err.textContent=d.error||('HTTP '+resp.status); return; }
 err.textContent='';
 // under a time window "never fired" means silent-in-window, not retirable — say which one
 const windowed=!!(val('since')||val('days'));
 const t=d.totals;
 document.getElementById('cards').innerHTML =
   [['runs',t.runs,false],['rules fired',t.fired,false],
    [windowed?'silent in window':'never fired',t.dead,t.dead>0],
    ['digest only',t.digest_only,false],['registry',t.registry,false]]
   .map(c=>"<div class='card"+(c[2]?' warn':'')+"'><span>"+c[0]+"</span><b>"+c[1]+"</b></div>").join("");

 const days=d.by_day;
 chart('dayChart',{type:'line',data:{labels:days.map(v=>v.day),
   datasets:[
     {label:'runs',data:days.map(v=>v.runs),borderColor:COLOR.accent,backgroundColor:COLOR.accent,
      tension:.2,pointRadius:2},
     {label:'failing runs',data:days.map(v=>v.failing_runs),borderColor:COLOR.fail,backgroundColor:COLOR.fail,
      tension:.2,pointRadius:2}
   ]},
   options:{plugins:{legend:{labels:{usePointStyle:true,boxWidth:8,padding:16}}},
     scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:COLOR.border}}}}});

 const jitDays=d.jit_by_day;
 chart('ruleUsageChart',{type:'line',data:{labels:jitDays.map(v=>v.day),
   datasets:[
     {label:'unique rules delivered',data:jitDays.map(v=>v.unique_jit_rules),
      borderColor:COLOR.accent,backgroundColor:COLOR.accent,tension:.2,pointRadius:2}
   ]},
   options:{plugins:{legend:{labels:{usePointStyle:true,boxWidth:8,padding:16}}},
     scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:COLOR.border}}}}});

 setTable('jitTable', d.most_delivered.slice(0,50), ['fqid','jit_delivered']);

 const fail=d.violated.slice(0,50);
 chart('failChart',{type:'bar',data:{labels:fail.map(v=>v.fqid),
   datasets:[
     {label:'fail',data:fail.map(v=>v.fails),backgroundColor:COLOR.fail,borderRadius:4,maxBarThickness:22},
     {label:'pass',data:fail.map(v=>v.passes),backgroundColor:COLOR.pass,borderRadius:4,maxBarThickness:22}
   ]},
   options:{indexAxis:'y',plugins:{legend:{labels:{usePointStyle:true,boxWidth:8,padding:16}}},
     scales:{x:{stacked:true,grid:{color:COLOR.border}},
     y:{stacked:true,grid:{display:false},ticks:{callback:function(v){
       const l=this.getLabelForValue(v);
       return l.length>36 ? l.slice(0,33)+'…' : l;
     }}}}}});
 setTable('failTable', fail, ['fqid','fails','passes','violation_rate'], {violation_rate:pct});

 setTable('citedTable', d.most_cited.slice(0,20), ['fqid','cited']);
 setTable('residentTable', d.resident, ['fqid','cited']);
 setTable('retireTable', d.retire, ['fqid','delivered','cited','rows']);
}
load();
</script></body></html>"""


def build_payload(service=None, days=None, source=None, since=None, root=None) -> dict:
    root = paths.project_root(root)
    rules = lib.load_all(report.default_roots(root))
    rows = report.filter_rows(ledger.load_ledger(ledger.default_path(root)),
                              service, days, source, since)
    return report.aggregate(rows, rules, service=service, days=days, since=since, root=root)


def _static_file(name: str):
    # reject traversal (e.g. "../report.py") before it ever touches the filesystem
    path = (VENDOR / name).resolve()
    if VENDOR.resolve() not in path.parents or not path.is_file():
        return "404 Not Found", [("Content-Type", "text/plain")], [b"not found"]
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return "200 OK", [("Content-Type", ctype)], [path.read_bytes()]


def create_app(service=None, root=None):
    """Returns a plain WSGI callable — no framework, stdlib only."""

    def app(environ, start_response):
        path = environ.get("PATH_INFO", "/")
        query = parse_qs(environ.get("QUERY_STRING", ""))
        q = lambda key: (query.get(key) or [None])[0]

        if path == "/":
            body = PAGE.encode("utf-8")
            start_response("200 OK", [("Content-Type", "text/html; charset=utf-8")])
            return [body]

        if path == "/data.json":
            # query-arg overrides the CLI --service default; an empty value keeps the default
            svc = q("service") or service
            src = q("src") or None   # coerce '' (e.g. ?src=) to None
            try:
                days = int(q("days")) if q("days") else None
            except ValueError:
                days = None   # matches Flask's request.args.get(..., type=int) behaviour
            since = q("since") or None
            try:
                payload = build_payload(svc, days, src, since, root)
                status, body = "200 OK", json.dumps(payload).encode("utf-8")
            except ValueError as exc:
                # an unparseable ?since= must not 500 nor silently return an empty window
                status = "400 Bad Request"
                body = json.dumps({"error": f"bad since: {exc}"}).encode("utf-8")
            start_response(status, [("Content-Type", "application/json")])
            return [body]

        if path.startswith("/static/"):
            status, headers, body = _static_file(path[len("/static/"):])
            start_response(status, headers)
            return body

        start_response("404 Not Found", [("Content-Type", "text/plain")])
        return [b"not found"]

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--service", default=None)
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "dashboard"):
        return
    print(f"knowledge dashboard: http://127.0.0.1:{a.port}  (Ctrl-C to stop)")
    make_server("127.0.0.1", a.port, create_app(a.service, root)).serve_forever()


if __name__ == "__main__":
    main()
