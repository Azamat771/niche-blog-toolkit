# niche-blog-toolkit

> A self-hosted single-page **content studio** for niche Instagram bloggers.
> Curated idea bank with structured hooks/CTAs · AI generator with live trends · SMM and UGC agents · Profile packaging worksheet.
> Vanilla HTML/JS frontend · tiny Node backend · DeepSeek (LLM) + Tavily (web search). MIT.

**[🇷🇺 README на русском](./README.ru.md)**

---

## What it is

Most "AI content tools" are generic SaaS for *any* creator and feel like ChatGPT wrappers.
This toolkit takes the opposite bet: **one creator, one niche, deep specialization**.

You configure a single `niche.json` (audience, tone, rubrics, color palette, packaging defaults).
The toolkit renders a polished mobile-first web app where you:

- **Browse a curated idea bank.** Every idea ships with the *hook (first 3 sec)* → *what to shoot* → *retention trick* → *CTA* → *why it works* → goal badges (reach / saves / engagement). Examples come with **150+ ideas for the houseplants niche** and **30 for fitness**.
- **Generate fresh ideas** with one button. The AI reads your "profile packaging" texts + live niche trends (via Tavily web search, cached 12h) + the current season + your last 8 titles (anti-repeat) and returns a structured post idea.
- **Use the SMM agent** — 4 actions: captions + hashtags, weekly content plan, adapt a post to Telegram/VK, Stories activities for the week.
- **Use the UGC agent** — 4 actions: UGC script (hook → body → CTA + storyboard + voice-over), brand pitch letter, ideas by product category, one-page media kit with prices.
- **Fill in your Profile Packaging** (positioning, name keywords, bio, link tree, highlights, pinned posts, visual rules, voice). These texts become the context every AI feature reads.

Data lives in the browser (`localStorage`). The only thing the backend sees is what you actively send to AI features.

## Stack

- **Frontend** — single `index.html` (~140 KB), no build step, no framework. Mobile-first, sticky tabs, ≥44 px tap targets, no iOS zoom on focus.
- **Backend** — `~500-line` Node `http`/`https` server. **Zero dependencies.**
  - `POST /api/generate` — structured idea JSON (DeepSeek JSON mode)
  - `POST /api/agent` — SMM/UGC actions (DeepSeek markdown)
  - `GET  /api/health` — status + spend + trend cache age
- **LLM** — [DeepSeek](https://platform.deepseek.com) (OpenAI-compatible, ~$0.0005 per call).
- **Trends** — [Tavily](https://app.tavily.com) (1000 free searches/month). Cached 12 h → ~60 calls/month.
- **Anti-abuse** — CORS + shared token + per-IP rate-limit + daily USD cost-cap → 429.

## Quick start

```bash
# 1. Clone
git clone https://github.com/Azamat771/niche-blog-toolkit
cd niche-blog-toolkit

# 2. Backend config
cp backend/.env.example backend/.env
# edit backend/.env — set DEEPSEEK_API_KEY and (optional) TAVILY_API_KEY

# 3. Render the demo (plants — 154 ideas) into frontend/dist/index.html
node scripts/apply-niche.js examples/plants

# 4. Start backend
cd backend && node server.js
# Backend listens on 127.0.0.1:3007 by default

# 5. Open the rendered frontend
#    (any static file is fine — frontend/dist/index.html)
#    For real use, host it behind nginx and proxy /api/ to 127.0.0.1:3007.
```

## Make your own niche

```bash
# 1. Copy the fitness example and edit it for your niche
cp -r examples/fitness examples/my-niche
$EDITOR examples/my-niche/niche.json
#   → set title, brand, niche, audience, tone, rubrics, trendQuery, colors,
#     packaging defaults

# 2. Generate a starter idea bank (writes seed-ideas.json)
node scripts/seed-ideas.js examples/my-niche --count=100

# 3. Render and serve
node scripts/apply-niche.js examples/my-niche
# → frontend/dist/index.html is ready to scp anywhere
```

Cost of step 2: ~$0.02 in DeepSeek tokens for 100 ideas.

## Repo layout

```
niche-blog-toolkit/
├── frontend/
│   ├── index.template.html       # Master template with placeholders
│   └── dist/index.html           # Rendered output (gitignored)
├── backend/
│   ├── server.js                 # Zero-dep Node server
│   ├── package.json
│   └── .env.example
├── config/
│   ├── niche.schema.json         # JSON Schema for niche.json
│   └── default.niche.json        # Neutral default config
├── examples/
│   ├── plants/                   # Full demo: 154 hand-curated ideas
│   │   ├── niche.json
│   │   └── seed-ideas.json
│   └── fitness/                  # Second demo: 30 AI-generated ideas
│       ├── niche.json
│       └── seed-ideas.json
├── scripts/
│   ├── build-template.js         # One-time: build index.template.html
│   ├── apply-niche.js            # CLI: render template + niche → dist
│   └── seed-ideas.js             # CLI: AI-generate seed-ideas.json
├── docs/                         # Screenshots, deploy guide
├── README.md (this) · README.ru.md
└── LICENSE (MIT)
```

## How the idea structure works

Every idea — curated or AI-generated — is shaped to maximize Instagram reach signals (sends, saves, watch time):

| Field | What it answers | Why it matters |
|---|---|---|
| `hook` | What to literally say/show in the **first 3 seconds** | 50% of viewers drop in the first 3 s. The hook is the single most important field. |
| `shoot` | What to film / show step-by-step | Removes "what do I even shoot?" friction |
| `retention` | Trick that keeps viewers watching (open loop, counter, "wait for it") | Watch time is a top algorithm signal in 2025–2026 |
| `cta` | Save / send to a friend / comment | Sends are the strongest reach multiplier on Instagram |
| `why` | Why this idea works on the algorithm and audience | Teaches the user; not just "do this" but "and here's why" |
| `viral` | Tags: `reach` / `saves` / `engagement` | Visible as badges on cards |

## Configuration cheatsheet (`niche.json`)

| Key | Description |
|---|---|
| `name` | slug used in `localStorage` key and CLI |
| `title` / `subtitle` / `emoji` | shown in header and `<title>` |
| `brand` | default Instagram handle in header chip (e.g. `@my_blog`) |
| `niche` | injected into every AI prompt (e.g. `"home workouts and health"`) |
| `audience` | injected into every AI prompt |
| `tone` | voice rules (e.g. `"warm, on first-name basis, no jargon"`) |
| `rubrics[]` | filter chips and rubric tags. 10–14 recommended. Each: `{id,name,emoji,color}` |
| `trendQuery` | Tavily search template. Supports `{month}`, `{year}`, `{niche}` placeholders. |
| `colors` | `primary`, `primaryDark`, `accent`, `bg` (hex) — re-skins the whole UI |
| `packaging.*` | default texts for the Profile Packaging tab (positioning, bio, highlights, tone, etc.) |

See [`config/niche.schema.json`](./config/niche.schema.json) for the full schema.

## Roadmap / known gaps

- [ ] Auto-posting (currently copy-paste only)
- [ ] Performance feedback loop (mark "this post hit / flopped" → AI learns)
- [ ] Competitor / peer benchmarking
- [ ] Video script → Reel pipeline (a la Veo / Sora)
- [ ] TikTok / YouTube Shorts adapter
- [ ] OpenAI / Anthropic / local LLM adapters (only DeepSeek today)
- [ ] More language packs (only Russian today)
- [ ] More example niches (cooking, beauty, parenting, travel…)

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Also in this repo: `zakupki/`

An unrelated standalone tool that lives here for convenience: an analyzer for Russian
public procurement (44-ФЗ / 223-ФЗ) that finds tenders **nobody bid on** and ranks
niches with no competitors. Zero dependencies, its own CLI, its own data — it shares
nothing with the content studio above. See [zakupki/README.md](./zakupki/README.md).

## Acknowledgements

The plants example (154 ideas, full structured form) is the curated dataset of a working blog
hand-tuned for the houseplant niche; it's included verbatim so anyone can study what a
finished niche looks like. The fitness example is AI-generated as a smaller starter and a
showcase of `scripts/seed-ideas.js`.

## License

MIT — do whatever, including commercial. See [LICENSE](./LICENSE).
