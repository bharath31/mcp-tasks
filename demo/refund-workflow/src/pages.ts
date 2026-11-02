// Two small pages: start a refund, then watch its run wait for a verified decision.
const shell = (title: string, body: string, script = "") =>
  new Response(
    `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#666;--line:#eaeaea;--ok:#0a7d38;--no:#c4161c;--warn:#a35200}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Geist,sans-serif;-webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--line);background:#fff}header div{max-width:640px;margin:0 auto;padding:14px 16px;font-weight:600;letter-spacing:-.01em}
main{max-width:640px;margin:0 auto;padding:40px 16px 64px}
h1{margin:0 0 8px;font-size:28px;line-height:1.2;letter-spacing:-.03em;font-weight:650}
.lede{margin:0 0 28px;color:#444}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 20px}
label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
input{width:100%;font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:8px;margin:0 0 14px;background:#fff}
input:focus{outline:2px solid #000;outline-offset:-1px}
button,a.button{display:inline-block;font:inherit;font-weight:550;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid var(--fg);background:var(--fg);color:#fff;text-decoration:none}
button.secondary,a.secondary{background:#fff;color:var(--fg);border-color:var(--line)}
.row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.k{color:var(--muted)}code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f2f2;border-radius:5px;padding:1px 5px;word-break:break-all}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;border:1px solid var(--line);background:#fff}
.pill.waiting{color:var(--warn)}.pill.refunded{color:var(--ok)}.pill.rejected,.pill.errored{color:var(--no)}
.actions{display:flex;gap:10px;flex-wrap:wrap}.meta{font-size:13px;color:var(--muted);margin:14px 0 0}
ol{margin:0;padding-left:18px;color:#444}li{margin:4px 0}
</style>
<header><div>Refund Workflow</div></header><main>${body}</main>${script ? `<script>${script}</script>` : ""}</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

export const home = () =>
  shell(
    "Refund Workflow",
    `<h1>Refunds that wait for a real yes</h1>
<p class=lede>The agent's refund runs as a Cloudflare Workflow. It pauses until someone with the <b>finance</b> role approves with a passkey, and only an Auth0-signed decision for exactly this refund can resume it.</p>
<form class=card id=f>
  <label for=p>Payment</label><input id=p name=paymentId value="pay_${Math.random().toString(36).slice(2, 8)}" pattern="[A-Za-z0-9_-]{1,64}" required>
  <label for=a>Amount (USD cents)</label><input id=a name=amountMinor type=number min=1 value=15000 required>
  <button>Ask the agent to refund</button>
</form>
<ol><li>The workflow asks for approval and waits.</li><li>Try sending it a forged approval: it's refused and the run keeps waiting.</li><li>Approve with your passkey: the refund runs once, keyed by the approval.</li></ol>`,
    `document.getElementById("f").onsubmit=async(e)=>{e.preventDefault();const d=new FormData(e.target);
const r=await fetch("/api/refunds",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paymentId:d.get("paymentId"),amountMinor:Number(d.get("amountMinor"))})});
const j=await r.json();if(j.id)location.href="/refunds/"+j.id;else alert("Could not start: "+(j.error||r.status));};`,
  );

export const refundPage = (id: string) =>
  shell(
    "Refund run",
    `<h1>Refund run</h1><p class=lede>Run <code>${id}</code></p>
<div class=card>
  <div class=row><span class=k>Status</span><span class="pill" id=s>starting</span></div>
  <div class=row><span class=k>Detail</span><span id=d>Waiting for the workflow to ask.</span></div>
</div>
<div class=actions id=act hidden>
  <a class=button id=open target=_blank rel=noopener>Open approval page</a>
  <button class=secondary id=forge>Send a forged approval</button>
</div>
<p class=meta id=m></p>`,
    `const id=${JSON.stringify(id)};let type=null;
const $=(x)=>document.getElementById(x);
async function tick(){const r=await fetch("/api/refunds/"+id);const j=await r.json();
const out=j.output||{};const st=out.status||j.status;$("s").textContent=st;$("s").className="pill "+st;
if(j.link){$("act").hidden=false;$("open").href=j.link;try{const t=JSON.parse(atob(new URL(j.link).searchParams.get("r").split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));type="approval-"+t.r.id.slice(4,28);}catch{}
$("d").textContent="Waiting for someone with the finance role to approve with a passkey.";}
if(out.status==="refunded"){$("act").hidden=true;$("d").innerHTML="Refunded <code>"+out.refund.id+"</code>, approved by "+(out.approverName||out.approvedBy)+" with a "+out.method+". Idempotency key <code>"+out.refund.idempotencyKey+"</code>.";return;}
if(out.status==="rejected"){$("act").hidden=true;$("d").textContent="Rejected by "+out.by+". Nothing was refunded.";return;}
if(j.status==="errored"){$("act").hidden=true;$("d").textContent=String(j.error&&j.error.message||"The run failed.");return;}
setTimeout(tick,1500);}
$("forge").onclick=async()=>{if(!type)return;await fetch("/api/refunds/"+id+"/forge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type})});
$("m").textContent="Sent a forged approval event at "+new Date().toLocaleTimeString()+". The workflow received it, refused it, and is still waiting.";};
tick();`,
  );
