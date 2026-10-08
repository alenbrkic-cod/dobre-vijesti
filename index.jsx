import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRotateCw, ArrowUpRight } from '@openai/apps-sdk-ui/components/Icon'

/* ---------------------------------------------------------------- sources */
const SOURCES = [
  { id: 'klix', name: 'Klix', url: 'https://www.klix.ba/rss', color: '#2563eb' },
  { id: 'avaz', name: 'Avaz', url: 'https://avaz.ba/rss', color: '#16a34a' },
  { id: 'n1', name: 'N1', url: 'https://n1info.ba/feed/', color: '#dc2626' },
  { id: 'rsa', name: 'Radiosarajevo', url: 'https://radiosarajevo.ba/rss', color: '#9333ea' },
]
const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]))

/* --------------------------------------------------- sentiment lexicon (bs) */
// Roots are stored diacritic-normalized (č/ć→c, ž→z, š→s, đ→dj) and lowercase.
//
// Sharper, good-focused rules:
//  1. HARD_NEG is a veto — any tragedy/crime/disaster word blocks "positive"
//     outright, no matter how many cheerful words also appear.
//  2. STRONG_POS (clear good news) counts double; SOFT_POS counts single.
//  3. A story is shown only when strong good news is present, OR two soft
//     positives stack — a real bar, so stray positive words don't leak in.

const STRONG_POS = [
  'pobjed', 'pobijed', 'trijumf', 'prvak', 'zlatn', 'srebrn', 'medalj',
  'rekord', 'nagrad', 'nagradj', 'priznanj', 'spasen', 'spasil', 'spasio',
  'spasla', 'pronadjen ziv', 'ozdrav', 'izljec', 'izlijec', 'oporavi',
  'donacij', 'donira', 'humanitar', 'dobrotvor', 'stipendij', 'heroj',
  'hrabrost', 'najbolj', 'prvo mjesto', 'oslobodjen', 'izlijecen',
  'rekordn', 'procvat', 'cudo', 'spasava', 'pomogli',
]
const SOFT_POS = [
  'uspjeh', 'uspjesn', 'uspio', 'uspjel', 'podrsk', 'obnov', 'izgrad',
  'investicij', 'otvoren', 'otvara', 'zaposl', 'napred', 'cvjeta', 'talent',
  'nadaren', 'dogovor', 'sporazum', 'pomirenj', 'radost', 'srec', 'ponos',
  'zahval', 'osmijeh', 'nasmij', 'slavi', 'proslav', 'rodjen', 'vjencan',
  'ljubav', 'poklon', 'pomoc', 'pomog', 'rjesenj', 'rijesen', 'volontir',
]
// Veto words — their presence makes a story never "positive".
const HARD_NEG = [
  'smrt', 'poginu', 'umro', 'umrla', 'preminu', 'mrtav', 'mrtvo', 'stradao',
  'stradal', 'ubij', 'ubistv', 'ubio', 'ubila', 'samoubistv', 'silovanj',
  'silovan', 'krvav', 'nesrec', 'tragedij', 'tragic', 'katastrof', 'povrijed',
  'ozlijed', 'ranjen', 'zrtv', 'pozar', 'poplav', 'zemljotres', 'potres',
  'sudar', 'udes', 'uhapsen', 'uhicen', 'hapsenj', 'kriminal', 'korupcij',
  'prevar', 'kradj', 'pljack', 'droga', 'napad', 'nasilj', 'ratn', 'bomb',
  'eksplozij', 'oruzj', 'prijetnj', 'optuzn', 'osudjen', 'otmic', 'nestao',
  'nestala', 'nestal', 'bankrot', 'kriz', 'zlostavlj', 'pretukao', 'tuc',
]
// Softer negatives — colour the statistic, but are not a veto on their own.
const SOFT_NEG = [
  'protest', 'strajk', 'skandal', 'afer', 'istrag', 'gubitak', 'propast',
  'panika', 'upozor', 'opasn', 'bolest', 'zaraz', 'virus', 'epidemij',
  'pandemij', 'sukob', 'otpust', 'zatvor', 'oluj', 'nevrijem', 'pad ',
]

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[čć]/g, 'c')
    .replace(/ž/g, 'z')
    .replace(/š/g, 's')
    .replace(/đ/g, 'dj')
}
function countHits(text, roots) {
  let n = 0
  for (const r of roots) if (text.includes(r)) n++
  return n
}
// Valid strictness ids (used for prefs validation).
const STRICTNESS = { strict: 1, balanced: 1, wide: 1 }

// The tragedy veto (HARD_NEG) is always on — widening never shows a death or
// disaster as good. The levels differ in how much positive evidence is required:
//   strict   → a strong good-news signal in the headline
//   balanced → any clear positive word in headline or summary
//   wide     → everything that isn't bad news (includes neutral stories)
function classify(title, desc, level = 'balanced') {
  const t = norm(title)
  const full = norm(`${title} ${desc || ''}`)
  const veto = countHits(full, HARD_NEG) > 0
  const softNeg = countHits(full, SOFT_NEG) > 0
  const scoreTitle = countHits(t, STRONG_POS) * 2 + countHits(t, SOFT_POS)
  const scoreFull = countHits(full, STRONG_POS) * 2 + countHits(full, SOFT_POS)
  let isPositive
  if (level === 'strict') isPositive = !veto && scoreTitle >= 2
  else if (level === 'wide') isPositive = !veto && !softNeg
  else isPositive = !veto && scoreFull >= 1
  let label = 'neutral'
  if (isPositive) label = 'positive'
  else if (veto || softNeg) label = 'negative'
  return { label, score: scoreFull }
}

const LEVELS = [
  { id: 'strict', name: 'Strogo', hint: 'samo očito dobre vijesti' },
  { id: 'balanced', name: 'Uravnoteženo', hint: 'jasan pozitivan signal' },
  { id: 'wide', name: 'Široko', hint: 'sve osim loših vijesti' },
]

/* ------------------------------------------------------------- feed parsing */
function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
function pickLink(node) {
  // RSS <link>text</link>, or Atom <link href rel="alternate">
  const links = [...node.querySelectorAll('link')]
  for (const l of links) {
    const rel = l.getAttribute('rel')
    const href = l.getAttribute('href')
    if (href && (!rel || rel === 'alternate')) return href
  }
  const text = node.querySelector('link')?.textContent?.trim()
  if (text) return text
  return node.querySelector('guid')?.textContent?.trim() || ''
}
function parseFeed(text, sourceId) {
  const out = []
  let doc
  try {
    doc = new DOMParser().parseFromString(text, 'text/xml')
  } catch {
    return out
  }
  if (doc.querySelector('parsererror')) return out
  let nodes = [...doc.querySelectorAll('item')]
  if (!nodes.length) nodes = [...doc.querySelectorAll('entry')]
  for (const n of nodes) {
    const title = (n.querySelector('title')?.textContent || '').trim()
    if (!title) continue
    const desc = stripHtml(
      n.querySelector('description')?.textContent ||
        n.querySelector('summary')?.textContent ||
        '',
    )
    const dateStr =
      n.querySelector('pubDate')?.textContent ||
      n.querySelector('published')?.textContent ||
      n.querySelector('updated')?.textContent ||
      ''
    const t = dateStr ? Date.parse(dateStr) : NaN
    out.push({
      id: `${sourceId}:${title}`,
      source: sourceId,
      title,
      desc: desc.slice(0, 220),
      link: pickLink(n),
      time: Number.isNaN(t) ? 0 : t,
    })
  }
  return out
}

async function fetchAll(token) {
  const results = await Promise.allSettled(
    SOURCES.map(async (s) => {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(s.url)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`${s.name}: ${res.status}`)
      return parseFeed(await res.text(), s.id)
    }),
  )
  const items = []
  const failed = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value)
    else failed.push(SOURCES[i].name)
  })
  // de-duplicate by normalized title across sources
  const seen = new Set()
  const deduped = []
  for (const it of items) {
    const key = norm(it.title)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(it)
  }
  return { items: deduped, failed }
}

/* ------------------------------------------------------------------ helpers */
function timeAgo(ts) {
  if (!ts) return ''
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'upravo'
  if (m < 60) return `prije ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `prije ${h} h`
  const d = Math.round(h / 24)
  return `prije ${d} d`
}

/* --------------------------------------------------------------------- view */
function Ring({ pct }) {
  const R = 54
  const C = 2 * Math.PI * R
  const off = C * (1 - pct / 100)
  return (
    <svg className="dv-ring" viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
      <circle cx="64" cy="64" r={R} className="dv-ring-track" />
      <circle
        cx="64"
        cy="64"
        r={R}
        className="dv-ring-val"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 64 64)"
      />
      <text x="64" y="60" className="dv-ring-num">{pct}%</text>
      <text x="64" y="82" className="dv-ring-lbl">pozitivno</text>
    </svg>
  )
}

function Hero({ stats }) {
  const { total, positive, neutral, negative, pct } = stats
  const seg = (n) => (total ? `${(n / total) * 100}%` : '0%')
  return (
    <section className="dv-hero">
      <Ring pct={pct} />
      <div className="dv-hero-body">
        <h2 className="dv-hero-title">{positive} {positive === 1 ? 'dobra vijest' : 'dobrih vijesti'} danas</h2>
        <p className="dv-hero-sub">
          Samo {pct}% od {total} vijesti s bh. portala prođe kao istinski pozitivno.
          Ostatak ostaje skriven — ovdje je samo ono dobro.
        </p>
        <div className="dv-bar" role="img" aria-label={`Pozitivno ${positive}, neutralno ${neutral}, negativno ${negative}`}>
          <span className="dv-bar-pos" style={{ width: seg(positive) }} />
          <span className="dv-bar-neu" style={{ width: seg(neutral) }} />
          <span className="dv-bar-neg" style={{ width: seg(negative) }} />
        </div>
        <div className="dv-legend">
          <span><i className="dv-dot dv-dot-pos" />Pozitivno {positive}</span>
          <span><i className="dv-dot dv-dot-neu" />Neutralno {neutral}</span>
          <span><i className="dv-dot dv-dot-neg" />Negativno {negative}</span>
        </div>
      </div>
    </section>
  )
}

function Card({ item }) {
  const src = SOURCE_BY_ID[item.source]
  return (
    <a className="dv-card" href={item.link} target="_blank" rel="noopener noreferrer">
      <div className="dv-card-top">
        <span className="dv-badge" style={{ '--sc': src?.color }}>{src?.name}</span>
        <span className="dv-time">{timeAgo(item.time)}</span>
      </div>
      <h3 className="dv-card-title">{item.title}</h3>
      {item.desc ? <p className="dv-card-desc">{item.desc}</p> : null}
      <span className="dv-card-go">Otvori <ArrowUpRight width={14} height={14} /></span>
    </a>
  )
}

export default function App({ appId, token }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [failed, setFailed] = useState([])
  const [updated, setUpdated] = useState(0)
  const [filter, setFilter] = useState('all')
  const [level, setLevel] = useState('balanced')
  const readySignalled = useRef(false)
  const hydrated = useRef(false)

  async function load(isManual) {
    setLoading(true)
    setError('')
    try {
      const { items: fresh, failed: f } = await fetchAll(token)
      if (!fresh.length && f.length === SOURCES.length) {
        setError('Trenutno se ne mogu učitati vijesti. Pokušajte ponovo.')
      } else {
        setItems(fresh)
        setFailed(f)
        setUpdated(Date.now())
        try {
          await window.mobius?.storage?.set('cache.json', {
            items: fresh,
            failed: f,
            updated: Date.now(),
          })
        } catch {}
      }
      if (isManual) window.mobius?.signal?.('item_created', { type: 'refresh' })
    } catch (e) {
      setError('Greška pri učitavanju vijesti.')
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'load' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const prefs = await window.mobius?.storage?.get('prefs.json')
        if (alive && prefs?.level && STRICTNESS[prefs.level]) setLevel(prefs.level)
      } catch {}
      try {
        const cached = await window.mobius?.storage?.get('cache.json')
        if (alive && cached?.items?.length) {
          setItems(cached.items)
          setFailed(cached.failed || [])
          setUpdated(cached.updated || 0)
          setLoading(false)
        }
      } catch {}
      hydrated.current = true
      await load(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    window.mobius?.storage?.set('prefs.json', { level }).catch(() => {})
  }, [level])

  // Classify on the client so the strictness control reclassifies instantly.
  const classified = useMemo(
    () => items.map((it) => ({ ...it, ...classify(it.title, it.desc, level) })),
    [items, level],
  )

  const stats = useMemo(() => {
    let positive = 0
    let neutral = 0
    let negative = 0
    for (const it of classified) {
      if (it.label === 'positive') positive++
      else if (it.label === 'negative') negative++
      else neutral++
    }
    const total = classified.length
    return {
      total,
      positive,
      neutral,
      negative,
      pct: total ? Math.round((positive / total) * 100) : 0,
    }
  }, [classified])

  useEffect(() => {
    if (!loading && !readySignalled.current) {
      readySignalled.current = true
      window.mobius?.signal?.('app_ready', { item_count: items.length })
    }
  }, [loading, items.length])

  const positives = useMemo(
    () =>
      classified
        .filter((it) => it.label === 'positive')
        .filter((it) => filter === 'all' || it.source === filter)
        .sort((a, b) => (b.time || 0) - (a.time || 0) || (b.score || 0) - (a.score || 0)),
    [classified, filter],
  )

  const countFor = (sid) =>
    classified.filter((it) => it.label === 'positive' && (sid === 'all' || it.source === sid)).length

  return (
    <div className="dv-root">
      <style>{CSS}</style>
      <header className="dv-header">
        <div>
          <h1 className="dv-title">PoziNews</h1>
          <p className="dv-tag">Samo pozitivne vijesti iz bosanskohercegovačkih portala</p>
        </div>
        <button className="dv-refresh" onClick={() => load(true)} disabled={loading} aria-label="Osvježi">
          <ArrowRotateCw width={18} height={18} className={loading ? 'dv-spin' : ''} />
        </button>
      </header>

      {items.length > 0 && <Hero stats={stats} />}

      <div className="dv-strict">
        <div className="dv-strict-row">
          <span className="dv-strict-lbl">Strogost filtera</span>
          <div className="dv-seg" role="group" aria-label="Strogost filtera">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                className={`dv-seg-btn ${level === l.id ? 'dv-seg-on' : ''}`}
                aria-pressed={level === l.id}
                onClick={() => {
                  setLevel(l.id)
                  window.mobius?.signal?.('item_created', { type: 'strictness', level: l.id })
                }}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>
        <p className="dv-strict-hint">{LEVELS.find((l) => l.id === level)?.hint}</p>
      </div>

      <div className="dv-chips" role="tablist">
        {[{ id: 'all', name: 'Sve' }, ...SOURCES].map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={filter === s.id}
            className={`dv-chip ${filter === s.id ? 'dv-chip-on' : ''}`}
            onClick={() => setFilter(s.id)}
          >
            {s.name} <span className="dv-chip-n">{countFor(s.id)}</span>
          </button>
        ))}
      </div>

      {error ? (
        <div className="dv-state">
          <p>{error}</p>
          <button className="dv-retry" onClick={() => load(true)}>Pokušaj ponovo</button>
        </div>
      ) : loading && !items.length ? (
        <div className="dv-state"><p>Učitavanje vijesti…</p></div>
      ) : positives.length === 0 ? (
        <div className="dv-state">
          <p>Nema pozitivnih vijesti za ovaj izbor trenutno.</p>
        </div>
      ) : (
        <div className="dv-grid">
          {positives.map((it) => (
            <Card key={it.id} item={it} />
          ))}
        </div>
      )}

      <footer className="dv-foot">
        {failed.length ? <span className="dv-warn">Nedostupno: {failed.join(', ')}. </span> : null}
        {updated ? <span>Osvježeno {timeAgo(updated)}</span> : null}
      </footer>
    </div>
  )
}

/* --------------------------------------------------------------------- css */
const CSS = `
* { box-sizing: border-box; }
.dv-root {
  min-height: 100%;
  color: var(--text);
  background: var(--bg);
  font-family: var(--font);
  padding: 16px;
  max-width: 760px;
  margin: 0 auto;
  -webkit-font-smoothing: antialiased;
}
.dv-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.dv-title { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
.dv-tag { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.dv-refresh {
  flex: 0 0 auto; width: 44px; height: 44px; border-radius: 12px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  display: grid; place-items: center; cursor: pointer;
}
.dv-refresh:hover { background: var(--surface-2); }
.dv-refresh:disabled { opacity: 0.6; cursor: default; }
.dv-spin { animation: dv-rot 0.9s linear infinite; }
@keyframes dv-rot { to { transform: rotate(360deg); } }

.dv-hero {
  display: flex; align-items: center; gap: 18px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, var(--surface)), var(--surface));
  border: 1px solid var(--border); border-radius: 20px; padding: 18px; margin-bottom: 16px;
}
.dv-ring { flex: 0 0 auto; }
.dv-ring-track { fill: none; stroke: color-mix(in srgb, var(--text) 12%, transparent); stroke-width: 11; }
.dv-ring-val { fill: none; stroke: #22c55e; stroke-width: 11; stroke-linecap: round; transition: stroke-dashoffset 0.8s ease; }
.dv-ring-num { fill: var(--text); font-size: 26px; font-weight: 800; text-anchor: middle; }
.dv-ring-lbl { fill: var(--muted); font-size: 11px; text-anchor: middle; letter-spacing: 0.04em; }
.dv-hero-body { flex: 1 1 auto; min-width: 0; }
.dv-hero-title { margin: 0 0 4px; font-size: 18px; font-weight: 700; line-height: 1.25; }
.dv-hero-sub { margin: 0 0 12px; color: var(--muted); font-size: 13px; line-height: 1.4; }
.dv-bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: var(--surface-2); }
.dv-bar-pos { background: #22c55e; }
.dv-bar-neu { background: color-mix(in srgb, var(--text) 22%, transparent); }
.dv-bar-neg { background: #ef4444; }
.dv-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12px; color: var(--muted); }
.dv-legend span { display: inline-flex; align-items: center; gap: 6px; }
.dv-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dv-dot-pos { background: #22c55e; }
.dv-dot-neu { background: color-mix(in srgb, var(--text) 22%, transparent); }
.dv-dot-neg { background: #ef4444; }

.dv-strict { margin-bottom: 14px; }
.dv-strict-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dv-strict-lbl { font-size: 13px; font-weight: 600; color: var(--muted); }
.dv-seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 3px; gap: 2px; }
.dv-seg-btn {
  border: none; background: transparent; color: var(--muted); cursor: pointer;
  padding: 7px 12px; border-radius: 8px; font-size: 13px; font-weight: 600; min-height: 36px;
}
.dv-seg-btn:hover { color: var(--text); }
.dv-seg-on { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
.dv-strict-hint { margin: 6px 2px 0; font-size: 12px; color: var(--muted); }

.dv-chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 14px; -webkit-overflow-scrolling: touch; }
.dv-chip {
  flex: 0 0 auto; border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 999px; padding: 8px 13px; font-size: 13px; cursor: pointer; min-height: 36px;
  display: inline-flex; align-items: center; gap: 6px;
}
.dv-chip-on { background: var(--accent); color: #fff; border-color: transparent; }
.dv-chip-n { font-size: 11px; opacity: 0.8; font-weight: 600; }

.dv-grid { display: grid; gap: 12px; }
@media (min-width: 620px) { .dv-grid { grid-template-columns: 1fr 1fr; } }
.dv-card {
  display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: inherit;
  background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 14px;
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.dv-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.dv-card-top { display: flex; align-items: center; justify-content: space-between; }
.dv-badge {
  font-size: 11px; font-weight: 700; color: #fff; background: var(--sc, var(--accent));
  padding: 2px 8px; border-radius: 6px; letter-spacing: 0.02em;
}
.dv-time { font-size: 11px; color: var(--muted); }
.dv-card-title { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.3; }
.dv-card-desc { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dv-card-go { margin-top: auto; font-size: 12px; font-weight: 600; color: var(--accent);
  display: inline-flex; align-items: center; gap: 4px; }

.dv-state { text-align: center; color: var(--muted); padding: 40px 16px; font-size: 14px; }
.dv-retry, .dv-state .dv-retry {
  margin-top: 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 10px; padding: 9px 16px; cursor: pointer; min-height: 40px;
}
.dv-foot { margin-top: 18px; text-align: center; font-size: 11px; color: var(--muted); }
.dv-warn { color: #ef4444; }

@media (prefers-reduced-motion: reduce) {
  .dv-spin { animation: none; }
  .dv-ring-val { transition: none; }
  .dv-card { transition: none; }
}
`
