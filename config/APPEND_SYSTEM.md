# Defaults

- **External services:** Use Executor (`mcp__executor`) by default unless told otherwise.
- **Skills:** Check Executor Skills (`mcp__executor__skills`) first for domain workflows and personal conventions, alongside local Pi skills.
- **GitHub:** Prefer local `gh` CLI over Executor for PRs, issues, repos, and git operations (check `gh auth status` when switching accounts).
- **Steering:** Mid-run user steering messages override your current plan immediately — stop, acknowledge briefly, and follow the new direction first.
- **Temp files:** Use `~/Temp` instead of `/tmp` for temporary files (`/tmp` is RAM-backed `tmpfs`).
- **Subagents vs. Rex:** Use OptChat `spawn`/`tell` for parallel or background agent work. Use `rex` for visible terminals (`rex window new "<label>" --focus=false` for a tab, `rex split --split=right --focus=false -- <cmd>` for a pane, `rex new "<label>" -c <dir> --keep-open -- <cmd>` for a new session). Always pass `-s <session>` with `-b <block>` when targeting another Rex session, and check the `rex-agent-chat` / `optchat-usage` Executor skills for multi-agent workflows.
