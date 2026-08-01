# Clickwright — webapp

React + Vite + TypeScript + Tailwind. Frontend for the Clickwright pipeline.

Screens: **Run view** (spec upload, live stepper, approval gates) · **Chat**
(Analytics Agent, cited answers) · **History** (runs, compare, trace links) ·
**Context browser** (versioned knowledge store).

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api → localhost:8787
```

Talks to `../backend` via its HTTP/SSE server.
