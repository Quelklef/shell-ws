
- Feat: Support for larger data loads (processing MB+ at a time)

- Feat: Potentially, some sort of mechanism for abstraction / reuse / "function definition"

- Bug: Some graphs just not workin (try the bottom-left node on the L247 graph)

- Feat(internal): Can we get type-safe IDs for both frontend and backend? In Haskell I could do something like `newtype Id (for :: String) = Id String`, so that `Id "user"` and `Id "animal"` do not unify

- Bug: Bash syntax errors are not showing up in stderr. (Fixed now, could add a regression test)

- Bug: Currently if I run a node that produces no stdout, it does not appear to clear the materialized stdout.

- For AI SCRIPT nodes:
  - Feat: Add a "tweak" affordance to AI SCRIPT which allows the user to specify a tweak. It should prompt the LLM to tweak the existing script AND existing AI prompt as requested.
  - Feat: Have the script proper hidden by default, and add a checkbox to show it.

- Feat: Currently there is a 250ms delay inserted after a node execution finishes and before its output is propagated downstream; remove it.
  Except, we still want delay when there are cycles in the graph. So, for each wire, track a hidden ms delay on it that is unused (and not shown in the UI) unless the wire is in a cycle.
  When there is a cycle in the graph, choose a minimal set of wires to enable the delay on. The algorithm for choosing this set can be whatever you want but should be deterministic off of graph structure alone.
  Make the default delay 500ms.

