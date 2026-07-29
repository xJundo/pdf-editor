---
name: rewrite
description: Use this skill whenever the user runs the "/rewrite" command followed by some instructions. It sends the text after /rewrite to a dedicated Sonnet 5 subagent whose only job is to reformulate it into a clearer, more precise, unambiguous version, then hands that clarified instruction back so you execute it directly — as if the user had typed the clarified version themselves. Always trigger on literal "/rewrite ..." input, even if the trailing text is short, vague, or has typos: that vagueness is exactly what this skill exists to fix before anything gets acted on.
---

## What this does

The text after `/rewrite` is not the task to plan or execute yet — it's raw material for a dedicated rewriting pass. Reformulating a request and then acting on it are different jobs. Separating them, by handing the raw text to a subagent whose *only* job is to rewrite (with none of the surrounding conversation's momentum or your own ideas about how to solve it), produces a cleaner instruction than trying to do both at once.

## Steps

1. **Extract the raw text.** Take everything the user wrote after `/rewrite`. If there's nothing there, ask the user what they want reformulated — don't guess at it.

2. **Spawn the rewriter, in the foreground, blocking.** Call the Agent tool with:
   - `subagent_type: general-purpose`
   - `model: sonnet` (forces Sonnet 5 regardless of whatever model is powering this conversation)
   - `run_in_background: false` — required. Do not proceed, respond, or do any other work until this call returns. The whole point of this skill is that the rewrite finishes before anything else happens.
   - A prompt giving the subagent exactly one job — rewrite, don't execute:

     ```
     Your only task is to reformulate the following user instruction into a clearer,
     more precise, and unambiguous version. Do not execute it, research it, or take
     any actions — you have no need for tools here. Preserve the original intent and
     scope exactly: do not add requirements, remove constraints, or answer the
     request. Fix ambiguity, underspecified references, and structure; make implicit
     asks explicit where the wording clearly implies them, but never invent details
     the user didn't provide. Output ONLY the rewritten instruction as plain text —
     no preamble like "Here's the rewritten version:", no surrounding quotes, no
     commentary.

     Original instruction:
     <raw text>
     ```

3. **Take the subagent's output as the new instruction.** Once it returns, that text — not the user's original wording — is what you now treat as the actual request.

4. **Tell the user what changed, briefly, then act on it directly.** In one short line, show the reformulated instruction (e.g. "Reformulated as: ..."), then continue straight into working the task with your own model and tools, exactly as you would if the user had typed that reformulated text themselves. Do not pause to ask the user to approve the rewrite — showing it is for transparency, not permission. Your normal judgment about when a task needs a clarifying question, a plan, or confirmation before risky actions still applies — just apply it to the rewritten instruction, not the raw one.

## Notes

- If the rewritten instruction ends up nearly identical to the original (because it was already clear), that's fine — proceed with it as-is.
- If the subagent's output looks like it tried to answer or execute the request instead of rewriting it, discard that output, don't act on it, and fall back to reformulating the original text yourself before proceeding.
