/**
 * Creative Plan Finite State Machine (FSM)
 *
 * Implements Section P1.12 - P1.14 of Hardening / Release-Blocker Fixes:
 * - Explicit lifecycle: DRAFT -> READY_FOR_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED
 * - Failure branches: REJECTED, FAILED, PARTIALLY_COMPLETED
 * - Idempotent approval: approving already approved plan is a clean no-op
 * - Rejection guards: cannot approve after execution, rejection, or failure
 * - Guaranteed terminal transitions: execution failure transitions to FAILED
 */

import type { CreativePlanStatus } from "./plan.ts";

export const CreativePlanState = {
  DRAFT: "draft",
  READY_FOR_APPROVAL: "ready_for_approval",
  AWAITING_APPROVAL: "awaiting_approval", // backwards-compatible alias
  APPROVED: "approved",
  EXECUTING: "executing",
  COMPLETED: "completed",
  PARTIALLY_COMPLETED: "partially_completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  ABSTAINED: "abstained",
  REJECTED: "rejected",
} as const;

export type CreativePlanState = CreativePlanStatus;

export interface StateTransitionResult {
  success: boolean;
  previousState: CreativePlanState;
  newState: CreativePlanState;
  alreadyInState?: boolean;
  error?: string;
}

/**
 * Validates and executes an explicit state transition on a Creative Plan.
 */
export function transitionCreativePlanState(
  current: CreativePlanState,
  target: CreativePlanState
): StateTransitionResult {
  // 1. Idempotency check: target matches current
  if (current === target) {
    return {
      success: true,
      previousState: current,
      newState: target,
      alreadyInState: true,
    };
  }

  // 2. DRAFT transitions
  if (current === "draft") {
    if (
      target === "ready_for_approval" ||
      target === "awaiting_approval" ||
      target === "rejected" ||
      target === "cancelled" ||
      target === "abstained"
    ) {
      return { success: true, previousState: current, newState: target };
    }
    return {
      success: false,
      previousState: current,
      newState: current,
      error: `Invalid transition from DRAFT to ${target}. Must advance through approval review first.`,
    };
  }

  // 3. READY_FOR_APPROVAL / AWAITING_APPROVAL transitions
  if (current === "ready_for_approval" || current === "awaiting_approval") {
    if (target === "approved" || target === "rejected" || target === "cancelled") {
      return { success: true, previousState: current, newState: target };
    }
    return {
      success: false,
      previousState: current,
      newState: current,
      error: `Invalid transition from ${current} to ${target}. Plans awaiting review may only be approved, rejected, or cancelled.`,
    };
  }

  // 4. APPROVED transitions
  if (current === "approved") {
    if (target === "executing" || target === "cancelled" || target === "failed") {
      return { success: true, previousState: current, newState: target };
    }
    return {
      success: false,
      previousState: current,
      newState: current,
      error: `Invalid transition from APPROVED to ${target}. Approved plans can only start execution or be cancelled.`,
    };
  }

  // 5. EXECUTING transitions
  if (current === "executing") {
    if (target === "completed" || target === "partially_completed" || target === "failed") {
      return { success: true, previousState: current, newState: target };
    }
    return {
      success: false,
      previousState: current,
      newState: current,
      error: `Invalid transition from EXECUTING to ${target}. Executing plans must terminate in COMPLETED, PARTIALLY_COMPLETED, or FAILED.`,
    };
  }

  // 6. Terminal states (COMPLETED, PARTIALLY_COMPLETED, FAILED, REJECTED, CANCELLED, ABSTAINED)
  return {
    success: false,
    previousState: current,
    newState: current,
    error: `Cannot transition out of terminal state '${current}'.`,
  };
}
