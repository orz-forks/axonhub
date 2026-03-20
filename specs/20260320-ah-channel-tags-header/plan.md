# Plan: Ah-Channel-Tags Header

## Step 1: Add `Ah-Channel-Tags` to blocked headers

**File**: `llm/httpclient/utils.go`

Add `"Ah-Channel-Tags": true` to the `blockedHeaders` map, alongside the existing `Ah-Trace-Id` and `Ah-Thread-Id` entries. This prevents the header from being forwarded to upstream providers.

## Step 2: Add `HeaderChannelTags` field to `PersistenceState`

**File**: `internal/server/orchestrator/state.go`

Add a `HeaderChannelTags []string` field to the `PersistenceState` struct, in the "Request state" section.

## Step 3: Parse the header in the orchestrator

**File**: `internal/server/orchestrator/orchestrator.go`

In the `Process` method, after creating the `state`, parse the `Ah-Channel-Tags` header from `request.Headers`:

```go
if tagHeader := request.Headers.Get("Ah-Channel-Tags"); tagHeader != "" {
    state.HeaderChannelTags = parseChannelTags(tagHeader)
}
```

Add a `parseChannelTags` helper (in the same file or a small util) that splits by comma, trims whitespace, and filters empty strings.

## Step 4: Apply header tags filter in `selectCandidates`

**File**: `internal/server/orchestrator/select_candidates.go`

After the profile-based `ChannelTags` filter (line 35), add:

```go
if len(inbound.state.HeaderChannelTags) > 0 {
    selector = WithTagsFilterSelector(selector, inbound.state.HeaderChannelTags)
}
```

## Step 5: Add tests

**File**: `internal/server/orchestrator/select_candidates_test.go`

Add test cases for:
1. Header tags filter applied alone (no profile tags)
2. Header tags filter applied after profile tags (intersection behavior)
3. Empty header value is a no-op
4. Header with whitespace around tags is handled correctly

Also add a test for `parseChannelTags` helper.
