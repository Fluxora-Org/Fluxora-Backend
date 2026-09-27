/**
 * Startup readiness state manager.
 *
 * Tracks the completion of startup phases and provides both query and event-driven
 * interfaces for dependency readiness. The HTTP server accepts traffic only after
 * all dependencies report ready.
 *
 * ## Phases
 *
 * Startup progresses through ordered phases:
 *
 * 1. **INITIALIZING** — Service starting, dependencies not yet probed.
 * 2. **DEPENDENCIES_READY** — Startup probes (database, Redis, Stellar RPC) complete.
 * 3. **POOL_READY** — Database connection pool fully initialized and warm.
 * 4. **REDIS_READY** — Redis clients initialized (or marked degraded).
 * 5. **INDEXER_READY** — Indexer state loaded and background jobs started.
 * 6. **READY** — All dependencies ready; service accepts traffic.
 * 7. **SHUTTING_DOWN** — Graceful shutdown initiated; no new requests accepted.
 *
 * ## Readiness Query
 *
 * - `isReady()` — Returns true only when the service reaches the READY phase.
 * - `getPhase()` — Returns the current startup phase (for diagnostics).
 * - `onReadyChanged` event — Emits when the service transitions to/from ready state.
 *
 * ## Integration
 *
 * The readiness middleware (`readinessGuardMiddleware`) uses `isReady()` to reject
 * requests during startup with 503 Service Unavailable. Transition to READY is
 * driven by `markReady()` called once all dependencies finish initialization.
 *
 * ## Testing
 *
 * `_resetReadinessState()` clears all state for test isolation.
 * `_setPhase()` allows tests to simulate arbitrary phase transitions.
 */

import { EventEmitter } from 'events';
import { logger } from '../lib/logger.js';

export type StartupPhase =
  | 'INITIALIZING'
  | 'DEPENDENCIES_READY'
  | 'POOL_READY'
  | 'REDIS_READY'
  | 'INDEXER_READY'
  | 'READY'
  | 'SHUTTING_DOWN';

interface ReadinessState {
  phase: StartupPhase;
  ready: boolean;
  transitionedAtMs: number;
}

class ReadinessManager extends EventEmitter {
  private state: ReadinessState = {
    phase: 'INITIALIZING',
    ready: false,
    transitionedAtMs: Date.now(),
  };

  /**
   * Query whether the service is ready to accept traffic.
   * Returns true only after the service transitions to the READY phase.
   */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Get the current startup phase (for diagnostics and logging).
   */
  getPhase(): StartupPhase {
    return this.state.phase;
  }

  /**
   * Get the elapsed time (in ms) since the last phase transition.
   */
  getPhaseElapsedMs(): number {
    return Date.now() - this.state.transitionedAtMs;
  }

  /**
   * Mark startup dependencies as ready.
   * Transitions from INITIALIZING to DEPENDENCIES_READY.
   */
  markDependenciesReady(): void {
    this.setPhase('DEPENDENCIES_READY');
  }

  /**
   * Mark the database pool as fully initialized.
   * Transitions from DEPENDENCIES_READY to POOL_READY.
   */
  markPoolReady(): void {
    if (this.state.phase !== 'DEPENDENCIES_READY') {
      logger.warn('Unexpected phase transition to POOL_READY from non-DEPENDENCIES_READY state', undefined, {
        currentPhase: this.state.phase,
      });
    }
    this.setPhase('POOL_READY');
  }

  /**
   * Mark Redis clients as initialized (or degraded).
   * Transitions from POOL_READY to REDIS_READY.
   */
  markRedisReady(): void {
    if (this.state.phase !== 'POOL_READY') {
      logger.warn('Unexpected phase transition to REDIS_READY from non-POOL_READY state', undefined, {
        currentPhase: this.state.phase,
      });
    }
    this.setPhase('REDIS_READY');
  }

  /**
   * Mark the indexer state as loaded and background jobs started.
   * Transitions from REDIS_READY to INDEXER_READY.
   */
  markIndexerReady(): void {
    if (this.state.phase !== 'REDIS_READY') {
      logger.warn('Unexpected phase transition to INDEXER_READY from non-REDIS_READY state', undefined, {
        currentPhase: this.state.phase,
      });
    }
    this.setPhase('INDEXER_READY');
  }

  /**
   * Mark all dependencies ready and the service ready to accept traffic.
   * Transitions from INDEXER_READY to READY.
   * Emits 'readyChanged' event.
   */
  markReady(): void {
    if (this.state.phase !== 'INDEXER_READY') {
      logger.warn('Unexpected phase transition to READY from non-INDEXER_READY state', undefined, {
        currentPhase: this.state.phase,
      });
    }
    this.setPhase('READY');
    this.emit('readyChanged', { ready: true, phase: 'READY' });
  }

  /**
   * Mark the service as shutting down.
   * Stops accepting new requests (readiness returns false).
   * Transitions to SHUTTING_DOWN.
   * Emits 'readyChanged' event.
   */
  markShuttingDown(): void {
    this.setPhase('SHUTTING_DOWN');
    this.emit('readyChanged', { ready: false, phase: 'SHUTTING_DOWN' });
  }

  /**
   * Register a listener for readiness state changes.
   * Called when the service transitions to/from a ready state.
   *
   * @param listener Callback receiving { ready: boolean, phase: StartupPhase }
   */
  onReadyChanged(listener: (event: { ready: boolean; phase: StartupPhase }) => void): void {
    this.on('readyChanged', listener);
  }

  /**
   * Remove a readiness listener.
   */
  offReadyChanged(listener: (event: { ready: boolean; phase: StartupPhase }) => void): void {
    this.off('readyChanged', listener);
  }

  /**
   * Set the phase and update readiness state accordingly.
   * @internal
   */
  private setPhase(phase: StartupPhase): void {
    const prevPhase = this.state.phase;
    const prevReady = this.state.ready;

    this.state.phase = phase;
    this.state.ready = phase === 'READY' && phase !== 'SHUTTING_DOWN';
    this.state.transitionedAtMs = Date.now();

    if (prevPhase !== phase) {
      logger.info('startup:phase_transition', undefined, {
        from: prevPhase,
        to: phase,
        ready: this.state.ready,
      });
    }

    // Emit only when readiness changes (not on every phase transition)
    if (prevReady !== this.state.ready) {
      this.emit('readyChanged', { ready: this.state.ready, phase });
    }
  }

  /**
   * For testing: reset all state to initial conditions.
   * @internal
   */
  _reset(): void {
    this.state = {
      phase: 'INITIALIZING',
      ready: false,
      transitionedAtMs: Date.now(),
    };
    this.removeAllListeners();
  }

  /**
   * For testing: force a phase transition without validation.
   * @internal
   */
  _setPhase(phase: StartupPhase): void {
    this.setPhase(phase);
  }
}

/**
 * Global singleton instance for startup readiness management.
 */
const readinessManager = new ReadinessManager();

export function isReady(): boolean {
  return readinessManager.isReady();
}

export function getPhase(): StartupPhase {
  return readinessManager.getPhase();
}

export function getPhaseElapsedMs(): number {
  return readinessManager.getPhaseElapsedMs();
}

export function markDependenciesReady(): void {
  readinessManager.markDependenciesReady();
}

export function markPoolReady(): void {
  readinessManager.markPoolReady();
}

export function markRedisReady(): void {
  readinessManager.markRedisReady();
}

export function markIndexerReady(): void {
  readinessManager.markIndexerReady();
}

export function markReady(): void {
  readinessManager.markReady();
}

export function markShuttingDown(): void {
  readinessManager.markShuttingDown();
}

export function onReadyChanged(listener: (event: { ready: boolean; phase: StartupPhase }) => void): void {
  readinessManager.onReadyChanged(listener);
}

export function offReadyChanged(listener: (event: { ready: boolean; phase: StartupPhase }) => void): void {
  readinessManager.offReadyChanged(listener);
}

/**
 * For testing: reset readiness state.
 * @internal
 */
export function _resetReadinessState(): void {
  readinessManager._reset();
}

/**
 * For testing: force a phase transition.
 * @internal
 */
export function _setPhase(phase: StartupPhase): void {
  readinessManager._setPhase(phase);
}

export default readinessManager;
