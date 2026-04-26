# Fix dubbogo/timer Close() Deadlock

## 现象

axonhub 在线服务卡死 155 分钟。前台 ClearCache 一直在 blocking，所有依赖 enabled-channel 缓存的强制重载都排队在 singleflight 上。

## 排查过程

通过 `kill -QUIT` 抓 goroutine dump，定位到死锁的完整栈：

```
ClearCache (GraphQL)
  → ChannelService.ReloadEnabledChannelsCache
  → live.Cache.Load(ctx, force=true)
  → singleflight.Group.Do("load:force")
  → live.Cache.loadInternal
  → reloadMu.Lock()
  → onSwap (channel.go:264)
  → stopTokenProvider (per-channel)
  → DeviceFlowProvider.StopAutoRefresh (device_flow_provider.go:462)
  → executors.PoolScheduleExecutor.Shutdown (schedule_executor.go:139)
  → defer p.tw.Close() (schedule_executor.go:131)
  → dubbogo/timer.TimerWheel.Close (timer.go:479)
  → wg.Wait()           ← 永远阻塞
```

dump 中有 6 个 ReloadEnabledChannelsCache 在 singleflight 排队，3 个 timer wheel 主循环 goroutine 仍 park 在 `timer.go:205` (selectgo)。

## 根本原因

**dubbogo/timer v0.1.0 的 `Close()` 有 deadlock bug**：

1. `Close()` 调 `Stop()` + `wg.Wait()`。
2. `Stop()` 只设 `enable.Store(false)` 和 `ticker.Stop()`，**没有任何唤醒 select 的信号**。
3. `time.Ticker.Stop()` 不关闭 `ticker.C`（Go stdlib 行为），只停止发送。
4. 主循环 goroutine 在一个 `for { ... select { case <-ticker.C: ...; case <-timerQ.Out(): ... } }` 里：
   - `enable` 检查在 select 之外，已 park 的 goroutine 看不到。
   - `ticker.C` 不再发送，case 永不触发。
   - `timerQ` 没被关闭（源码里 `// close(w.timerQ) // to defend data race warning` 被注释掉），其 `Out()` channel 也永不关闭。
   - 没有第三个 case。
5. 主循环 goroutine 永远 park，`wg.Wait()` 永远等不到。

已被 codex 独立审核确认（参考 Go stdlib `tick.go:49-51` 关于 `time.Ticker.Stop` 不关 channel 的明确说明）。

## 放大因素

axonhub 的设计将这个上游 bug 放大成全局服务卡死：

1. 每个 OAuth channel（claudecode、copilot、antigravity、codex 等）独占一个 `PoolScheduleExecutor`，每个 executor 懒加载一个 TimerWheel。
2. `ChannelService.onEnabledChannelsSwap` 串行调用所有旧 channel 的 `stopTokenProvider`——**第一个卡住，后面全卡**。
3. `live.Cache.loadInternal` 在 `reloadMu` 锁内同步调用 `onSwap`——onSwap 卡死，整个 cache 的 force reload 全部 deadlock。
4. `Shutdown(context.Background())` 用无超时 ctx，没有逃生口。

## 修复目标

只修上游 bug，**不动 axonhub 自身代码**——侵入性最小。

Local replace dubbogo/timer，加 quit channel，让 TimerWheel 主循环 select 能正确退出。
