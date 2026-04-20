# Targ Golden Dataset

This folder scaffolds the golden evaluation corpus for Targ.

Goals:
- keep evaluation cases versionable
- support repeated offline runs
- seed representative cases now
- leave room for 30 disciplined golden cases total

Structure:
- `index.json`: master scaffold with seeded and placeholder cases
- `cases/*.json`: authored seeded cases ready for the eval runner

Categories:
- `obvious_bug`
- `contradiction`
- `insufficient_evidence`
- `false_lead`
- `multi_step_regression`
- `risky_handoff_case`

Current status:
- representative seeded cases are authored
- remaining cases are scaffold placeholders in `index.json`
