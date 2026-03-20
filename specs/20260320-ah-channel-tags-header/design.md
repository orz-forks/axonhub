# Design: Ah-Channel-Tags Header

## Overview

Add support for the `Ah-Channel-Tags` request header to allow clients to dynamically filter channels by tags at request time. This filtering is applied **after** the API key profile's channel tag configuration, acting as an additional narrowing filter.

## Request Format

```
Ah-Channel-Tags: tag1,tag2,tag3
```

Comma-separated list of tag names. Whitespace around tags is trimmed.

## Architecture

The implementation follows the same patterns as the existing `Ah-Trace-Id` / `Ah-Thread-Id` headers:

1. **Header is blocked from upstream forwarding** — added to the blocked headers list in `llm/httpclient/utils.go`
2. **Header is parsed in the orchestrator** — the `Process` method already has access to `request.Headers`; we parse the tags there and store them on `PersistenceState`
3. **Tags are applied as an additional filter** — in `selectCandidates`, after the profile-based tag filter, we apply another `WithTagsFilterSelector` with the header tags

### Why not middleware?

Unlike `Ah-Trace-Id` and `Ah-Thread-Id` which need to create/query database entities (Trace, Thread), `Ah-Channel-Tags` only needs to influence channel selection. The orchestrator already has the HTTP request headers available, so parsing there is simpler and avoids unnecessary context plumbing.

### Filter Ordering

```
Base candidates (all enabled channels for model)
  → Profile ChannelIDs filter (if configured)
    → Profile ChannelTags filter (if configured)
      → Ah-Channel-Tags header filter (if present)   ← NEW
        → Native tools filter (if applicable)
          → Stream policy filter
            → Load balancer
```

The header filter uses the existing `WithTagsFilterSelector` (OR logic: channel passes if it has **any** of the specified tags). Since it wraps the already-filtered selector, it further narrows the candidate set — this is the "filter after profile configuration" behavior.

### Example

- Profile `ChannelTags`: `["premium", "fast"]` — selects channels with tag `premium` OR `fast`
- Header `Ah-Channel-Tags: fast` — from those results, keeps only channels with tag `fast`
- Net effect: only channels tagged `fast` (that were already in the profile's set)

## Changes Summary

| File | Change |
|------|--------|
| `llm/httpclient/utils.go` | Add `"Ah-Channel-Tags"` to `blockedHeaders` |
| `internal/server/orchestrator/state.go` | Add `HeaderChannelTags []string` field |
| `internal/server/orchestrator/orchestrator.go` | Parse header and populate state |
| `internal/server/orchestrator/select_candidates.go` | Apply header tags filter after profile filter |
