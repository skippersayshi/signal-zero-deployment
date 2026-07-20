# Signal-Zero Swarm Controller

Signal-Zero is een real-time dashboard voor AI-ondersteunde codegeneratie met gescheiden modelrollen. De applicatie draait op Express, Socket.io en TypeScript en streamt stdout/stderr live naar de browser.

## Kernconcept

Het kernconcept is asynchrone specialisatie met deterministische validatie.

Een enkel LLM als generalistische programmeur gebruiken is kwetsbaar: hetzelfde model moet dan tegelijk architectuurkeuzes maken, code schrijven en zijn eigen fouten herkennen. Signal-Zero splitst dat proces in harde rollen:

- Orchestrator: maakt de technische blauwdruk en bewaakt systeemcontext.
- Builder: zet de blauwdruk om naar uitvoerbare TypeScript/Node-output.
- Reviewer: vergelijkt de implementatie met prompt, context en blauwdruk en geeft PASS/FAIL-feedback.

De rollen worden bewust gescheiden. De output van elke stap wordt de input van de volgende stap. Als de reviewer een foutsignaal geeft, triggert de pipeline een repair-pass bij de builder.

## High-Performance Orchestrator

De huidige high-performance preset gebruikt deze combinatie:

- Orchestrator: `anthropic/claude-opus-4.8` via OpenRouter.
- Builder: `deepseek/deepseek-v4-pro` via OpenRouter.
- Reviewer: `models/gemini-pro-latest` direct via Google, met OpenRouter Gemini als fallback wanneer nodig.

Deze combinatie is gekozen omdat de rollen verschillende capaciteiten nodig hebben:

- De orchestrator heeft sterke contextretentie en redenering nodig.
- De builder heeft snelle, syntaxgerichte codegeneratie nodig.
- De reviewer heeft brede patroonherkenning en strikte validatie nodig.

Belangrijk: dit project noemt dit een preset, geen universele waarheid. Modelkwaliteit en beschikbaarheid veranderen. Controleer daarom API-toegang en model-ID's regelmatig.

## Wat De Build Nu Ondersteunt

- Single-model run via `POST /api/start`.
- Parallel multi-model run via `POST /api/start-multi`.
- High-performance orchestrator pipeline via `POST /api/start-orchestrator`.
- Preset-inspectie zonder secrets via `GET /api/orchestrator/preset`.
- Realtime logging via Socket.io.
- API-configuratie met gemaskeerde keys in de browser.
- Lokale fallback-output wanneer een provider-call faalt.

De orchestrator-output wordt geschreven naar:

```text
output/orchestrated-module.ts
```

Parallelle model-output wordt geschreven naar:

```text
output/generated-module-<index>.ts
```

## Quick Start

### Vereisten

- Node.js 18+
- npm

### Installatie

```bash
npm install
```

### Starten

```bash
npm start
```

Dashboard:

```text
http://localhost:3088
```

### Development

```bash
npm run dev
```

### Build Check

```bash
npm run build
```

## API Configuratie

Gebruik lokaal `api-config.json` of environment variables. Commit nooit echte API keys.

Voorbeeld zonder secrets:

```bash
api-config.example.json
```

Genegeerde lokale bestanden:

- `.env`
- `api-config.json`
- `test-context.txt`
- `temp-runner*.ts`
- `output/`

## API Endpoints

- `GET /` - Dashboard UI.
- `GET /api/config` - Actieve providerconfig, met API key gemaskeerd.
- `POST /api/config` - Providerconfig opslaan.
- `POST /api/test` - Providerverbinding testen.
- `GET /api/orchestrator/preset` - High-performance rolpreset zonder API keys.
- `POST /api/start` - Single-model run.
- `POST /api/start-multi` - Parallelle multi-model run.
- `POST /api/start-orchestrator` - Orchestrator -> Builder -> Reviewer pipeline.
- `POST /api/stop` - Actieve child-processen stoppen.

## Projectstructuur

```text
signal-zero-deployment/
|-- server.ts                 # Express + Socket.io dashboard en endpoints
|-- v2-errorhandling.ts       # Provider calls, fallback, orchestrator pipeline
|-- api-config.example.json   # Secret-vrij configuratievoorbeeld
|-- package.json              # Scripts en dependencies
|-- tsconfig.json             # TypeScript-configuratie
|-- README.md                 # Projectuitleg
```

## Huidige Beperkingen

- De orchestrator pipeline draait in-process. `POST /api/stop` stopt child-process runs, maar kan een lopende provider-call in de orchestrator nog niet hard cancellen.
- De reviewer gebruikt model-feedback plus een repair-pass. Extra deterministische checks, zoals `tsc` op gegenereerde code, kunnen later worden toegevoegd.
- Groq en Hugging Face zijn alleen bruikbaar wanneer hun lokale tokens geldig en voldoende geautoriseerd zijn.

## GitHub

Repo:

```text
git@github.com:skippersayshi/signal-zero-deployment.git
```
