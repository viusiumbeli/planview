# COMD-1348 — Prevent thread blocking in Promo Service when account info is unavailable

## Context

**COMD-1348** (Bug, component `Back`, assignee me, **In Progress**, created 2026-05-20).

| Step | What happens |
|---|---|
| 1 | Promo campaigns expire |
| 2 | The service writes off rewards |

```kotlin
val result = repository.findExpired()
```
