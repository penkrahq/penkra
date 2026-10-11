CL='''<svg class="pi" viewBox="0 0 256 257"><path fill="#D97757" d="M50.23 170.32l50.36-28.26 0.843-2.46-0.843-1.36h-2.46l-8.43-0.518-28.77-0.778-24.95-1.04-24.18-1.3-6.09-1.3-5.71-7.504 0.583-3.76 5.12-3.43 7.32 0.648 16.2 1.1 24.3 1.69 17.63 1.04 26.12 2.72h4.15l0.583-1.69-1.43-1.04-1.1-1.04-25.15-17.05-27.220-18.02-14.26-10.37-7.71-5.25-3.89-4.92-1.69-10.76 7-7.71 9.4 0.649 2.4 0.648 9.53 7.32 20.35 15.75 26.584 19.575 3.89 3.24 1.55-1.1 0.195-0.777-1.75-2.92-14.45-26.12-15.43-26.57-6.87-11.02-1.81-6.610c-0.648-2.72-1.1-4.99-1.1-7.78l7.97-10.82 4.405-1.423 10.63 1.43 4.47 3.89 6.61 15.1 10.69 23.79 16.59 32.34 4.86 9.59 2.59 8.88 0.973 2.72h1.69v-1.56l1.36-18.21 2.53-22.36 2.46-28.78 0.843-8.1 4.02-9.72 7.97-5.25 6.22 2.98 5.12 7.32-0.713 4.73-3.05 19.770-5.96 30.98-3.89 20.74h2.27l2.59-2.59 10.5-13.93 17.63-22.04 7.78-8.75 9.07-9.66 5.83-4.6h11.02l8.1 12.05-3.63 12.44-11.34 14.39-9.4 12.18-13.48 18.15-8.43 14.52 0.778 1.17 2.01-0.194 30.46-6.48 16.46-2.98 19.64-3.37 8.88 4.15 0.971 4.21-3.5 8.62-21 5.18-24.63 4.93-36.68 8.69-0.454 0.32 0.519 0.65 16.53 1.55 7.07 0.389h17.3l32.21 2.4 8.43 5.57 5.05 6.8-0.843 5.18-12.96 6.61-17.5-4.15-40.83-9.72-14-3.5h-1.94v1.17l11.67 11.41 21.39 19.31 26.77 24.89 1.36 6.16-3.43 4.86-3.63-0.518-23.53-17.69-9.07-7.97-20.55-17.3h-1.36v1.81l4.73 6.93 25.02 37.59 1.3 11.54-1.81 3.76-6.48 2.27-7.13-1.3-14.65-20.54-15.1-23.14-12.19-20.74-1.49 0.84-7.19 77.45-3.37 3.95-7.78 2.98-6.48-4.92-3.44-7.97 3.44-15.75 4.15-20.54 3.37-16.33 3.05-20.29 1.81-6.74-0.13-0.454-1.49 0.19-15.29 21-23.27 31.43-18.41 19.7-4.41 1.75-7.65-3.95 0.713-7.06 4.28-6.29 25.47-32.41 15.36-20.09 9.92-11.6-0.065-1.69h-0.583l-67.669 43.947-12.05 1.55-5.18-4.86 0.65-7.97 2.46-2.59 20.35-14-0.64 0.06z"/></svg>'''
OA='<svg class="pi" viewBox="0 0 24 24"><g fill="none" stroke="#e6e6e6" stroke-width="1.6"><ellipse cx="12" cy="12" rx="4" ry="9"/><ellipse cx="12" cy="12" rx="4" ry="9" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="4" ry="9" transform="rotate(120 12 12)"/></g></svg>'
OC='<svg class="pi" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="2" fill="none" stroke="#e6e6e6" stroke-width="1.8"/><rect x="9" y="9" width="6" height="6" fill="#e6e6e6"/></svg>'
LOGO='<svg viewBox="0 0 512 512" class="{c}"><path fill="#F5F5F7" d="M89 278v-67c0-91.7 74.3-166 166-166 92.2 0 167 74.3 167 166 0 88.5-70.3 160.8-158.2 163H260v-71c50.8 0 92-41.2 92-92 0-52.5-42.5-95-95-95-54.7 0-99 43.1-99 95v67H89Zm0 25h69v164H89V303Z"/><path fill="#8CB8E1" d="M182 303h78v71h-78v-71Z"/></svg>'
SPIN='<span class="spin"></span>'
DONE='<svg class="st" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#3b82f6" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="#3b82f6" stroke-width="1.6"/></svg>'
ASK='<span class="ask">?</span>'
FOLD='<svg class="fi" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="#a3a3a3" stroke-width="1.6"/></svg>'
def sb(t='9:41'): return f'<div class="sbar"><b>{t}</b><span>●●● ▮</span></div>'
def comp(ph,stop=False,folder=None):
    top=f'<div class="ctx">{FOLD}<span>{folder}</span><i>⌄</i><span class="mac">▭ Emmanuel\'s MacBook Pro</span></div>' if folder else ''
    btn='<span class="send stop">■</span>' if stop else '<span class="send">↑</span>'
    return f'''<div class="comp">{top}<div class="cbox"><div class="ph">{ph}</div><div class="crow"><span class="ic">+</span><span class="acc">⛉ Full access ⌄</span><span class="grow"></span><span class="chip">{CL} Sonnet 5 ⌄</span><span class="chip">High ⌄</span><span class="ic">🎙</span>{btn}</div></div></div>'''
def row(icon,title,status='',sub=''):
    return f'<div class="tr">{icon}<div class="tt"><div>{title}</div>{f"<small>{sub}</small>" if sub else ""}</div>{status}</div>'
S=[]
S.append(("Sign in",f'''{sb()}<div class="center">{LOGO.format(c="biglogo")}<h1>Penkra</h1><p class="mut">Your Mac's threads, from your phone.</p>
<div class="btn w">Continue with email</div><div class="btn g dis">Sign in with Apple <small>· later</small></div><p class="fine">Use the same Penkra account as your Mac.</p></div>'''))
S.append(("Choose your Mac",f'''{sb()}<div class="hdr">{LOGO.format(c="lg")}<span>Choose a Mac</span></div><div class="pad"><p class="mut">Macs signed in to penkra.emmanuel…</p>
<div class="card on"><div><b>Emmanuel's MacBook Pro</b><small><i class="dot g"></i>Online · Penkra 0.14.4</small></div><span class="pill">Connect</span></div>
<div class="card"><div><b>Studio</b><small><i class="dot"></i>Offline · seen 2 d ago</small></div></div>
<div class="note"><b>First time on this Mac?</b><br>Penkra on the Mac asks “Allow iPhone?”. Approve it there.</div><p class="fine abs">Private connection built in. Nothing to install on the Mac.</p></div>'''))
S.append(("Spaces, folders, threads",f'''{sb()}<div class="hdr">{LOGO.format(c="lg")}<span>Penkra</span><span class="grow"></span><span class="ic">⌕</span><span class="ic">✎</span></div>
<div class="list"><div class="sp">Personal ⌄</div>{row(CL,"Plan product launch")}
<div class="sp">Work ⌄</div><div class="fo">{FOLD}<span>penkra</span></div>
<div class="in">{row(OA,"Penkra 0.14.4 clean rebuild",SPIN)}{row(CL,"Release notes",ASK)}{row(OC,"Fix thread ordering",DONE)}{row(CL,"Review voice input")}<div class="more">Show more</div></div>
<div class="fo">{FOLD}<span>penkra-apps</span></div><div class="in">{row(OA,"Explorer path cut",DONE)}</div>
<div class="fo">{FOLD}<span>hetzner-ops</span></div></div>
<div class="tab"><span class="on">Threads</span><span>Needs you <i class="badge">1</i></span><span>Settings</span></div>'''))
S.append(("New thread",f'''{sb()}<div class="hdr"><span class="ic">‹</span><span class="grow"></span></div><div class="hero">{LOGO.format(c="mid")}<h2>What should we do in <u>penkra</u>?</h2></div>
{comp("Do something",folder="penkra")}'''))
S.append(("Chat (live)",f'''{sb()}<div class="hdr"><span class="ic">‹</span>{OA}<div class="ht"><b>Penkra 0.14.4 clean rebuild</b><small>Work · penkra</small></div>{SPIN}</div>
<div class="chat"><div class="um">Finish the native-folder cut, then rerun the rehearsal.</div>
<p>Moved Claude conversations into the native-state folder. Switching now copies it.</p>
<div class="tool">✓ Ran <code>bun run test</code> · 85 passed</div><div class="tool">✎ Edited <code>ClaudeNativeStateBackfill.ts</code> <span class="add">+142</span> <span class="del">−0</span></div>
<div class="tool">⌘ Running rehearsal on run-6 copy…</div><p class="mut">Working · 4m 12s</p>
<div class="queued"><small>Queued</small> Also update TODO step 12.</div></div>
{comp("Steer or queue a message…",stop=True)}'''))
S.append(("Answer a question",f'''{sb()}<div class="hdr"><span class="ic">‹</span>{CL}<div class="ht"><b>Release notes</b><small>Work · penkra</small></div>{ASK}</div>
<div class="chat"><p>Draft is ready. One choice before I publish the notes:</p>
<div class="q"><b>Which channel ships 0.14.4?</b><div class="opt sel">Prerelease first</div><div class="opt">Stable directly</div><div class="opt in">Other…</div><div class="btn w">Send answer</div></div></div>'''))
S.append(("Model and effort",f'''{sb()}<div class="dim"></div><div style="position:absolute;inset:0;opacity:.35">{sb()}<div class="chat"><div class="um">Finish the native-folder cut.</div></div></div><div class="sheet"><div class="grab"></div><b class="sh">Model</b>
<div class="mrow sel">{CL}<span>Claude Sonnet 5</span><small>Claude · personal</small>✓</div><div class="mrow">{CL}<span>Claude Opus 5.5</span><small>Claude · personal</small></div>
<div class="mrow">{OA}<span>GPT-6.1</span><small>Codex · work</small></div><div class="mrow">{OC}<span>OpenCode Go</span><small>OpenCode</small></div>
<b class="sh">Effort</b><div class="seg"><span>Low</span><span>Medium</span><span class="on">High</span></div><b class="sh">Access</b><div class="seg"><span>Ask</span><span class="on">Full access</span></div></div>'''))
S.append(("Notifications",f'''<div class="lock"><div class="clock">9:41</div><div class="notif">{LOGO.format(c="nl")}<div><b>Release notes</b><br>Needs your answer: Which channel ships 0.14.4?</div></div><div class="notif">{LOGO.format(c="nl")}<div><b>Penkra 0.14.4 clean rebuild</b><br>Finished · 2 commits</div></div></div>'''))
S.append(("Mac offline",f'''{sb()}<div class="hdr">{LOGO.format(c="lg")}<span>Penkra</span></div><div class="warn"><b>Mac is asleep or offline.</b> Showing what loaded at 9:12. Sending works again when it's back.</div>
<div class="list off"><div class="sp">Work ⌄</div><div class="fo">{FOLD}<span>penkra</span></div><div class="in">{row(OA,"Penkra 0.14.4 clean rebuild")}{row(CL,"Release notes",ASK)}</div></div>
<div class="tab"><span class="on">Threads</span><span>Needs you</span><span>Settings</span></div>'''))
S.append(("Settings",f'''{sb()}<div class="hdr"><span>Settings</span></div><div class="pad"><div class="grp"><div class="gr"><span class="av">g</span><div><b>gigsama</b><small>penkra.emmanuel@gmail.com</small></div></div></div>
<div class="grp"><div class="gr"><div><b>Mac</b><small>Emmanuel's MacBook Pro · online</small></div><span class="mut">Change ›</span></div><div class="gr"><div><b>Notifications</b><small>Needs your answer, finished</small></div><span class="tog"></span></div></div>
<div class="grp"><div class="gr red">Sign out</div></div><p class="fine">Penkra 1.0 (TestFlight)</p></div>'''))
css=open('s.css').read()
cells=''.join(f'<figure><div class="ph1">{b}</div><figcaption>{i+1} · {t}</figcaption></figure>' for i,(t,b) in enumerate(S))
open('m.html','w').write(f'<html><head><meta charset=utf-8><style>{css}</style></head><body>{cells}</body></html>')
