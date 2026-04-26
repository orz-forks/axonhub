/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// LOCAL PATCH: regression test for the Close() deadlock fixed by 0001 in
// PATCHES.md. The original upstream Close() could hang forever on wg.Wait()
// because Stop() did not deliver any signal that could unblock the worker
// goroutine's parked select.
package gxtime

import (
	"testing"
	"time"
)

// TestTimerWheelClose_DoesNotDeadlockWhenWorkerParkedInSelect deterministically
// reproduces the upstream Close() deadlock scenario.
//
// To exercise the bug, the worker goroutine must already be parked inside its
// main-loop select when Stop() is invoked — otherwise it observes enable=false
// at the top of the loop and exits without ever entering the select. We force
// that state by scheduling a far-future timer via AddTimer and waiting for
// TimerNumber() to reflect it. TimerNumber is only incremented when the worker
// drains a TimerActionAdd from timerQ.Out(), which proves the worker reached
// the select at least once. Since the inserted timer is hours in the future
// and the ticker interval is ~10ms, immediately after the bump the worker is
// either back in the select (the common case) or about to re-enter it.
//
// Without the patch, Close() hangs on wg.Wait(). With the patch, the quit
// channel wakes the parked select and Close() returns promptly.
func TestTimerWheelClose_DoesNotDeadlockWhenWorkerParkedInSelect(t *testing.T) {
	w := NewTimerWheel()

	if _, err := w.AddTimer(func(_ TimerID, _ time.Time, _ interface{}) error {
		return nil
	}, TimerOnce, time.Hour, nil); err != nil {
		t.Fatalf("AddTimer failed: %v", err)
	}

	// Wait until the worker has consumed the AddTimer event from timerQ.
	// This guarantees it has executed at least one full select iteration and
	// is now (or imminently) parked again.
	deadline := time.Now().Add(2 * time.Second)
	for w.TimerNumber() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("worker goroutine never consumed AddTimer event")
		}
		time.Sleep(time.Millisecond)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Close()
	}()

	select {
	case <-done:
		// success
	case <-time.After(2 * time.Second):
		t.Fatal("TimerWheel.Close() deadlocked while worker was parked in select")
	}
}
