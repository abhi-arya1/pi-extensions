# Environment Defaults & Routing

## External Services & Skills — Executor First
- **Executor (`mcp__executor`) is the default connection for all external work** (Notion, Slack, Google, Mercury, Cloudflare, Supabase, ntfy, Artifacts, TLDraw, ChatGPT, Devin/DeepWiki, etc.) unless the user explicitly specifies another tool or direct CLI/API.
- **Skills usually live in Executor Skills** (`mcp__executor__skills` / the Executor `skills` app). Check Executor Skills first when looking for domain workflows, personal conventions, or agent-team skills (in addition to local Pi skills).
- **GitHub exception — prefer `gh` CLI**: For GitHub specifically (PRs, issues, repos, reviews, auth switching, cloning/pushing), prefer the local `gh` CLI over the Executor GitHub API — it is faster, cleaner, and handles git auth/remotes directly. (Note: check `gh auth status` if working across personal `abhi-arya1` vs work `abhi-reducto` accounts.)

## Steering Priority
- Mid-run user steering messages override your current plan immediately. Stop whatever step you were about to do, acknowledge the steering briefly, and follow the new direction first.
