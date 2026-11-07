---
description: Plan, implement and review a task, with fix rounds when review requests changes or verify fails.
stages: [{"tentacle": "plan"}, {"tentacle": "execute"}, {"tentacle": "review"}]
max_fix_rounds: 1
---
Notes for developers (never sent to agents): no stage sets autonomy, so each stage follows its tentacle's
autonomy (default ask: the chain pauses after plan and after execute). The review tentacle's autonomy
decides whether an approved, verified branch merges without a preview. Fix rounds never pause; set
max_fix_rounds: 0 for strict step-by-step.
