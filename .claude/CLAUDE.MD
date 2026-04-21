## Summarization

Explain in consise and plain terms. Be extremely consise only list relevant information. Sacrifice grammar for the sake of concision.

### Subagents for Independent Edits

When a task involves editing 3+ files that are independent of each other (e.g. separate
form components, unrelated screens), use subagents to parallelize the work. Each
subagent gets its own context window, keeping the main conversation lean. Reserve the
main conversation for coordinating, reviewing results, and files that depend on each
other. Subagent should be directly provided the relevant context it needs when created.
