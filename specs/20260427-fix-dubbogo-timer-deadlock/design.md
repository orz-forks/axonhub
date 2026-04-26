# Design: Fix dubbogo/timer Close() Deadlock

## 修复方案

只修上游 bug，**不动 axonhub 自己的代码**——侵入性最小。

将 `github.com/dubbogo/timer v0.1.0` 整包源码拷贝到 `third_party/dubbogo-timer/`，保留原 module path（`github.com/dubbogo/timer`），通过 go.mod `replace` 指向本地路径，并在拷贝的源码上打 patch 修复死锁。

这是 Go 社区标准做法，axonhub 已有先例（`gqlgen` / `go-sse` / `gin-contrib/sse`）。

---

## 1. 目录布局

```
axonhub/
├── go.mod                                  ← 加 replace
├── llm/
│   └── go.mod                              ← 也加 replace（相对路径 ../third_party/...）
└── third_party/
    └── dubbogo-timer/
        ├── LICENSE                         ← Apache-2.0（从 upstream 复制）
        ├── NOTICE                          ← upstream 有则复制
        ├── PATCHES.md                      ← 列出本地 patch 详情
        ├── go.mod                          ← module path 保持 github.com/dubbogo/timer
        ├── go.sum
        ├── timer.go                        ← 打 patch
        ├── sleep.go
        ├── ticker.go
        ├── time.go
        ├── count.go
        └── README.md
```

测试文件（除我们自己加的 regression test 外）和 `vendor/` 不复制，减小仓库噪音。

---

## 2. Patch 设计：加 quit channel

最干净的修法是给 TimerWheel 加一个专用的 `quit chan struct{}`：

```go
type TimerWheel struct {
    // ... existing fields ...
    quit chan struct{}   // LOCAL PATCH: signal main loop to exit
}

func NewTimerWheel() *TimerWheel {
    w := &TimerWheel{
        // ... existing init ...
        quit: make(chan struct{}),
    }
    // ... existing setup ...
    w.wg.Add(1)
    go func() {
        defer w.wg.Done()
        var (
            t     time.Time
            cFlag bool
        )
    LOOP:
        for {
            if !w.enable.Load() {
                break LOOP
            }
            select {
            case <-w.quit:                    // LOCAL PATCH: explicit quit signal
                break LOOP
            case t, cFlag = <-w.ticker.C:
                // ... unchanged ...
            case node, qFlag := <-w.timerQ.Out():
                // ... unchanged ...
            }
        }
        log.Printf("the timeWheel runner exit, ...")
    }()
    return w
}

func (w *TimerWheel) Stop() {
    w.once.Do(func() {
        w.enable.Store(false)
        close(w.quit)                          // LOCAL PATCH: wake up the main loop
        w.ticker.Stop()
    })
}
```

要点：

- `Stop()` 用 `sync.Once` 保护，所以多次调用安全（原作者已有 `w.once`）。
- `close(w.quit)` 只发生一次，主循环的 `case <-w.quit` 会立刻返回。
- `Close()` 不变（仍然 `Stop()` + `wg.Wait()`），但这次 `wg.Wait()` 能正常返回。

### 为什么不选 close(timerQ)？

原作者注释里写过 `// close(w.timerQ) // to defend data race warning`——说明他们试过但放弃了。原因是 `timerQ` 是 `*gxchan.UnboundedChan`，关闭它的 `In()` 端会和 `AddTimer` 路径产生 data race（`AddTimer` 异步往 `timerQ.In()` 发送 `timerNodeAction`）。我们走 quit channel 完全避开这个问题。

---

## 3. PATCHES.md

```markdown
# Local Patches over upstream dubbogo/timer

Forked from github.com/dubbogo/timer v0.1.0.

## 0001-fix-close-deadlock

### Symptom

`(*TimerWheel).Close()` deadlocked indefinitely on `wg.Wait()`. Reproducible
whenever a caller invoked `Close()` on a TimerWheel whose worker goroutine was
parked in its main `select`.

### Root cause

`Stop()` only set `enable=false` and called `ticker.Stop()`. The Go stdlib
`time.Ticker.Stop` does not close `ticker.C`, only stops sending. The other
select case `timerQ.Out()` was also never closed (the upstream `close(timerQ)`
line was commented out due to a data-race concern). With no signal able to
unblock the parked select, the worker goroutine could not exit and `wg.Wait()`
hung forever.

### Fix

Added a dedicated `quit chan struct{}` to TimerWheel. `Stop()` closes it inside
the existing `sync.Once`; the worker's `select` now has a third case
`<-w.quit:` which breaks the loop cleanly.

### Files

- `timer.go`: add `quit` field, init in `NewTimerWheel`, close in `Stop`,
  observe in main-loop select.

### Tracking

Reported upstream: <link or "not yet reported">.
Local incident: 2026-04-27, axonhub production hung 155 minutes.
```

---

## 4. LICENSE / NOTICE

Apache-2.0。从 upstream 仓库取 LICENSE 文件原文 + NOTICE（如有），放在 `third_party/dubbogo-timer/LICENSE` 和 `NOTICE`。

源码每个 `.go` 文件头部已经包含 ASF License header，保持不动。

---

## 5. go.mod replace

**Root `go.mod`**：

```
replace github.com/dubbogo/timer => ./third_party/dubbogo-timer
```

**`llm/go.mod`**：

```
replace github.com/dubbogo/timer => ../third_party/dubbogo-timer
```

注意 `llm/` 是独立 module，relative path 从 `llm/` 起算。

两个 module 都需要加，因为根 module 和 `llm/` module 都直接/间接依赖 `dubbogo/timer`（通过 `zhenzou/executors`）。

---

## 影响面

### 修改文件

| 文件 | 修改 |
|---|---|
| `third_party/dubbogo-timer/*` | 新增（fork + patch） |
| `go.mod` | +1 replace |
| `go.sum` | 自动更新 |
| `llm/go.mod` | +1 replace |
| `llm/go.sum` | 自动更新 |

### 不修改

- `internal/server/biz/channel.go` — `onEnabledChannelsSwap` 不变。
- `llm/oauth/*.go` — 不动 OAuth provider 实现。
- `internal/pkg/xcache/live/*.go` — onSwap 调用点不动。

### 风险

- **新增依赖维护成本**：以后 dubbogo/timer 升级要手动 rebase 我们的 patch（PATCHES.md 已记录，rebase 容易）。但 dubbogo/timer 已 4 年未更新，估计永远不会升级。
- **Apache-2.0 合规**：保留 LICENSE/NOTICE 即可，无额外约束。

---

## 测试方案

### 单元测试

在 `third_party/dubbogo-timer/` 加一个 deadlock regression 测试：

```go
package timer

import (
    "testing"
    "time"
)

func TestTimerWheelClose_DoesNotDeadlock(t *testing.T) {
    w := NewTimerWheel()

    done := make(chan struct{})
    go func() {
        defer close(done)
        w.Close()
    }()

    select {
    case <-done:
        // success
    case <-time.After(2 * time.Second):
        t.Fatal("TimerWheel.Close() deadlocked")
    }
}
```

### 集成测试（可选）

模拟 axonhub 场景：起一个 `executors.PoolScheduleExecutor`，schedule 一个任务（让 timer wheel 真正初始化），立刻 Shutdown，断言 Shutdown 在 timeout 内返回。

### 手动验证

复现原 bug：构造一个 OAuth channel（如 copilot），让其 token provider executor 启动；触发 `ReloadEnabledChannelsCache`；监控 ClearCache 调用是否在合理时间内返回。

---

## 不需要 api.md

本变更不涉及 API 设计变化，不创建 `api.md`。
