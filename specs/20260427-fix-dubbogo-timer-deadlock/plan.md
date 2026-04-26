# Plan: Fix dubbogo/timer Close() Deadlock

## 执行步骤

### Phase 0：准备

- [ ] **0.1** 从 git 历史确认 `dubbogo/timer v0.1.0` 的 commit SHA（用于 PATCHES.md 引用）。upstream: `https://github.com/dubbogo/timer/tree/v0.1.0`。
- [ ] **0.2** 从 upstream 下载 `LICENSE` 和 `NOTICE` 原文（不能依赖本地 mod cache，因为 cache 不带这两个文件）。
  - `curl -sL https://raw.githubusercontent.com/dubbogo/timer/v0.1.0/LICENSE -o /tmp/dubbogo-timer-LICENSE`
  - `curl -sL https://raw.githubusercontent.com/dubbogo/timer/v0.1.0/NOTICE -o /tmp/dubbogo-timer-NOTICE`（如果 upstream 没有 NOTICE 就跳过）

### Phase 1：建立 third_party/dubbogo-timer/

- [ ] **1.1** 创建目录 `third_party/dubbogo-timer/`。
- [ ] **1.2** 从 `/home/user/go/pkg/mod/github.com/dubbogo/timer@v0.1.0/` 复制以下文件到 `third_party/dubbogo-timer/`：
  - `timer.go`
  - `sleep.go`
  - `ticker.go`
  - `time.go`
  - `count.go`
  - `go.mod`
  - `go.sum`
  - `README.md`
  - **不复制**：`*_test.go`（除了我们自己加的 regression test）、`vendor/` 目录。
- [ ] **1.3** 复制 LICENSE 和 NOTICE（来自 Phase 0.2）。
- [ ] **1.4** 检查 `third_party/dubbogo-timer/go.mod` 的 module path 仍为 `module github.com/dubbogo/timer`，不修改。
- [ ] **1.5** 复制完成后，`cd third_party/dubbogo-timer && go build ./...` 确认能编译（不带 patch 的原始版本）。

### Phase 2：打 patch（修 deadlock）

- [ ] **2.1** 编辑 `third_party/dubbogo-timer/timer.go`：
  - 在 `TimerWheel` struct 加字段 `quit chan struct{}`，前面加注释 `// LOCAL PATCH:`。
  - `NewTimerWheel()` 初始化 `quit: make(chan struct{})`。
  - 主循环 select 加第一个 case：
    ```go
    case <-w.quit:
        break LOOP
    ```
  - `Stop()` 内 `w.once.Do(...)` 里加 `close(w.quit)`，放在 `enable.Store(false)` 之后、`ticker.Stop()` 之前。
- [ ] **2.2** 写 `third_party/dubbogo-timer/PATCHES.md`（按 design.md §3 的模板）。
- [ ] **2.3** 写 deadlock regression 测试 `third_party/dubbogo-timer/timer_close_test.go`：
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
      case <-time.After(2 * time.Second):
          t.Fatal("TimerWheel.Close() deadlocked")
      }
  }
  ```
- [ ] **2.4** `cd third_party/dubbogo-timer && go test -run TestTimerWheelClose -timeout 10s`，确认测试通过。

### Phase 3：接入 axonhub 两个 module

- [ ] **3.1** 编辑根 `go.mod`，在已有 replace 块附近加：
  ```
  replace github.com/dubbogo/timer => ./third_party/dubbogo-timer
  ```
- [ ] **3.2** 编辑 `llm/go.mod`，加：
  ```
  replace github.com/dubbogo/timer => ../third_party/dubbogo-timer
  ```
- [ ] **3.3** 在仓库根 `go mod tidy`，在 `llm/` 下也 `go mod tidy`。检查 `go.sum` 更新，`dubbogo/timer` 不再下载 upstream。
- [ ] **3.4** 在仓库根 `go build ./...`，在 `llm/` 下也 `go build ./...`，确认全部能编译。

### Phase 4：验证 & 文档

- [ ] **4.1** 在 PR description / commit message 写明：
  - 死锁现象。
  - dubbogo/timer 的 bug 描述（指向 PATCHES.md）。
- [ ] **4.2** （可选）准备一个能复现原 bug 的脚本，附在 spec 目录的 `repro.md` 里，供未来回归用。
- [ ] **4.3** 提交时按 axonhub 的提交风格（中英混合 OK，含 Co-Authored-By 行）。

---

## 验证清单

### 编译
- [ ] 根 `go build ./...` 通过
- [ ] `llm/` 内 `go build ./...` 通过
- [ ] `third_party/dubbogo-timer/` 内 `go build ./...` 通过

### 单元测试
- [ ] `TestTimerWheelClose_DoesNotDeadlock` 通过且 < 1s 完成
- [ ] 现有测试不退步（最小集合：`internal/server/biz/...` 和 `llm/oauth/...`）

### 行为验证（手动 / staging）
- [ ] 在 staging 触发 `ReloadEnabledChannelsCache`，ClearCache GraphQL 在 < 1s 返回
- [ ] 包含 OAuth channel（copilot/claudecode）也成立

### 回归
- [ ] axonhub Docker 镜像构建（`build-and-push.sh`）成功
- [ ] 启动后 channel cache 正常加载，OAuth channel 正常工作（能发 1 个真实请求验证）

---

## 回滚方案

如果上线后发现问题：

- 删除 root + llm 两个 go.mod 的 `replace github.com/dubbogo/timer` 行
- 删除 `third_party/dubbogo-timer/`
- `go mod tidy`

回到 upstream 原版（虽然有 deadlock，但至少行为已知）。整个改动在一个 commit 里，git revert 即可。

---

## 不在本次范围

- onSwap 异步化 / 加超时 / 与 reloadMu 解耦 —— 用户明确要求只修上游 bug，axonhub 自身代码不动。
- OAuth provider 改造（不再用 ants pool + timer wheel） —— 太大，单独立项。
- `live.Cache.loadInternal` 重构 —— 现状能容忍，不动。
