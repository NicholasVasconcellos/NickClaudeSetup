# Skills

Standalone markdown exports of the Claude Code skills defined under `.claude/skills/`. Each file contains the original YAML frontmatter and the skill body verbatim, so they can be read, shared, or reused outside of the Claude Code harness.

| Skill | Trigger | Purpose |
|-------|---------|---------|
| [discovery](./discovery.md) | `/discovery` | Scan services, tools, dependencies, and library versions; produce a readiness report. |
| [document](./document.md) | `/document` | Update or create project documentation after a task ships. |
| [execute](./execute.md) | `/execute` | Implement a task so the tests written in the spec phase pass. |
| [get-tasks](./get-tasks.md) | `/get-tasks` | Decompose a PRD, issue, or description into a flat DAG of self-contained tasks. |
| [get-tasks (milestones variant)](./get-tasks-milestones.md) | `/get-tasks` | Milestone-grouped decomposition with subagent-per-milestone task breakdown. |
| [review](./review.md) | `/review` | Quality gate: tests, OWASP checks, performance, dead code. |
| [spec](./spec.md) | `/spec` | Write failing tests from acceptance criteria — tests only, no implementation. |

Source of truth lives in `.claude/skills/<name>/SKILL.md`. Regenerate these artifacts whenever the underlying skill files change.
