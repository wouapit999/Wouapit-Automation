export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const attr = esc;

export function layout({ title, body, flash, active = '' }) {
  const nav = [
    ['/', 'Dashboard'], ['/import', 'Import product'], ['/products', 'Products'],
    ['/orders', 'Orders'], ['/purchase-orders', 'Supplier orders'], ['/settings', 'Settings'],
  ].map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Wouapit Automation</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d23;--muted:#667085;--line:#e4e7ec;--brand:#0b7a4b;--brand-ink:#fff;--warn:#b54708;--warn-bg:#fff4e5;--ok:#027a48;--ok-bg:#ecfdf3;--err:#b42318;--err-bg:#fef3f2;--info-bg:#eff8ff}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#0f1f17;color:#fff;padding:0 20px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
header .logo{font-weight:700;padding:14px 0}header nav a{color:#cfe8dc;text-decoration:none;padding:14px 10px;display:inline-block}
header nav a.active,header nav a:hover{color:#fff;box-shadow:inset 0 -3px 0 var(--brand)}
main{max-width:1100px;margin:0 auto;padding:20px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:18px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.03em}
tr:hover td{background:#fafbfc}
input[type=text],input[type=number],input[type=url],input[type=password],select,textarea{width:100%;padding:8px 10px;border:1px solid #cfd4dc;border-radius:7px;font:inherit;background:#fff}
textarea{min-height:120px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}label b{color:var(--ink)}
.row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
button,.btn{background:var(--brand);color:var(--brand-ink);border:0;border-radius:7px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:#fff;color:var(--ink);border:1px solid #cfd4dc}button.danger{background:var(--err)}
.flash{padding:12px 14px;border-radius:8px;margin-bottom:16px}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.err{background:var(--err-bg);color:var(--err)}.flash.warn{background:var(--warn-bg);color:var(--warn)}.flash.info{background:var(--info-bg)}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#eef2f6;color:#344054}
.badge.published,.badge.delivered,.badge.paid{background:var(--ok-bg);color:var(--ok)}.badge.pending,.badge.draft{background:var(--warn-bg);color:var(--warn)}.badge.ordered,.badge.shipped{background:var(--info-bg);color:#175cd3}.badge.error,.badge.cancelled{background:var(--err-bg);color:var(--err)}
.muted{color:var(--muted)}.small{font-size:13px}.right{text-align:right}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.thumbs img{width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--line);margin:0 6px 6px 0}
.breakdown td:last-child{text-align:right;font-variant-numeric:tabular-nums}
details summary{cursor:pointer;color:var(--brand);font-weight:600}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:13px}
</style></head><body>
<header><div class="logo">🛒 Wouapit Automation</div><nav>${nav}</nav></header>
<main>${flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.message)}</div>` : ''}${body}</main>
</body></html>`;
}

export function statusBadge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}
