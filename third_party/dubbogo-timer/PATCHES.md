# Local Patches over upstream dubbogo/timer

Forked from [github.com/dubbogo/timer](https://github.com/dubbogo/timer) at tag `v0.1.0` (released 2022-06-20).

The upstream module is licensed under Apache-2.0 (see `LICENSE`). This vendored
copy keeps the original module path `github.com/dubbogo/timer` and is wired in
via a `replace` directive in the consuming `go.mod` files.

Files copied verbatim from upstream `v0.1.0`:

- `timer.go` (with patches noted below)
- `sleep.go`
- `ticker.go`
- `time.go`
- `count.go`
- `go.mod`, `go.sum`
- `README.md`

Files added by us:

- `LICENSE` — Apache-2.0 text from the upstream master branch (the upstream
  v0.1.0 release archive does not ship a `LICENSE` file, but every source file
  carries an ASF Apache-2.0 header).
- `PATCHES.md` — this file.
- `timer_close_test.go` — regression test for the `Close()` deadlock.

Files **not** copied: upstream `*_test.go` files and the upstream `vendor/`
directory.

---

## 0001-fix-close-deadlock

### Symptom

`(*TimerWheel).Close()` could deadlock indefinitely on `wg.Wait()`. Reproduced
in axonhub production on 2026-04-27, where a `ChannelService` channel cache
swap stopped 33 OAuth token providers in sequence; the first
`PoolScheduleExecutor.Shutdown()` blocked inside `tw.Close()` for 155 minutes
before the process was killed with `SIGQUIT`. Three timer wheel worker
goroutines were observed parked in their main-loop `select`.

### Root cause

`Stop()` only set `enable=false` and called `ticker.Stop()`:

```go
// upstream Stop()
func (w *TimerWheel) Stop() {
    w.once.Do(func() {
        w.enable.Store(false)
        // close(w.timerQ) // to defend data race warning
        w.ticker.Stop()
    })
}
```

The worker goroutine checks `enable` only at the top of its `for` loop, before
entering `select`. Once parked in:

```go
select {
case <-w.ticker.C:    // ...
case <-w.timerQ.Out(): // ...
}
```

the goroutine has no way to wake up:

- `time.Ticker.Stop()` does **not** close `ticker.C`; it only stops sending
  (Go stdlib `tick.go`). A goroutine already parked on the receive stays
  parked forever.
- `w.timerQ` (a `*gxchan.UnboundedChan`) is **never** closed — the upstream
  author tried `close(w.timerQ)` but reverted it because closing the chan
  races with `AddTimer`, which writes to `timerQ.In()` from arbitrary
  goroutines.

With no signal able to unblock the parked select, the worker cannot exit and
`Close()`'s `wg.Wait()` hangs forever.

### Fix

Add a dedicated `quit chan struct{}` to `TimerWheel`. `Stop()` closes it
inside the existing `sync.Once`. The worker's `select` now has a `<-w.quit:
break LOOP` case, which fires immediately on close.

Why a separate quit channel rather than closing `timerQ`:

1. Avoids the `AddTimer` data race that the upstream comment explicitly
   warns about.
2. Idiomatic Go shutdown signaling — readers observe close, no value flows.
3. Single-direction: only ever closed once (guarded by `sync.Once`).

### Diff summary

In `timer.go`:

| Location | Change |
|---|---|
| `TimerWheel` struct | add `quit chan struct{}` field |
| `NewTimerWheel()` | initialize `quit: make(chan struct{})` |
| Worker goroutine `select` | add `case <-w.quit: break LOOP` as first case |
| `Stop()` | add `close(w.quit)` inside the `sync.Once.Do` block |

All four sites are tagged with a `// LOCAL PATCH:` comment.

### Tracking

- Local incident: 2026-04-27, axonhub production hung 155 minutes.
- Goroutine dump confirms the deadlock: 3 worker goroutines parked at
  `timer.go:205` `selectgo` for >155 minutes.
- Independent code review confirmed by codex (4.7) cross-checking the Go
  stdlib `time.Ticker.Stop` semantics.
- Reported upstream: not yet (upstream repo last commit is years old).
