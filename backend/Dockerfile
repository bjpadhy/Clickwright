# Clickwright backend — Express + tsx, talking to ClickHouse Cloud.
#
# Built from the REPO ROOT, not from backend/: the server resolves the sample
# specs at `../../../specs` relative to src/server/, which is `/app/specs` once
# the app lives at `/app/backend`. Keeping that layout means no path handling
# differs between a container and a checkout.
#
#   docker build -f backend/Dockerfile .
#
# Debian, not Alpine, deliberately: with no ANTHROPIC_API_KEY the LLM backend is
# the Claude Agent SDK, which unpacks and runs a bun-compiled binary. Those link
# against glibc and fail on musl, so Alpine would break agent calls in a way
# that only shows up at the first model request.
FROM node:20.20.2-bookworm-slim

# tsx runs the TypeScript directly, exactly as `npm run serve` does locally —
# there is no build step to drift from what is tested.
WORKDIR /app/backend

# Dependencies as their own layer, so editing a source file does not reinstall.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
# The spec library the run endpoints list and read. Also bind-mounted by compose
# so edits are live, but copied here too so the image runs on its own.
COPY specs /app/specs
COPY base_context.md /app/base_context.md

# Uploaded specs land here (`../../uploads` from src/server/runs.ts). A named
# volume is mounted over it in compose so uploads survive a rebuild.
RUN mkdir -p /app/backend/uploads

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# No dotenv file in the image — credentials arrive as real environment
# variables, which is what `src/core/env.ts` reads either way.
CMD ["npm", "run", "serve"]
