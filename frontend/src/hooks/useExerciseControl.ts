// =============================================================================
// useExerciseControl — React wrapper over the exercise-control controller
// =============================================================================
// Thin on purpose, mirrors hooks/useLinkControl.ts: all effectful logic lives
// in lib/exerciseControl.ts's framework-free controller, which is what the
// unit tests exercise directly. This hook only adds the React plumbing
// (one controller instance per mount, poll on mount, poll every 5s while
// mounted, re-render on state change) and the HQ view is the only place it
// is used, so it polls only "while the HQ view is
// mounted" — polling stops the moment this unmounts.
import { useEffect, useRef, useState } from 'react';
import { createExerciseControlController, type ExerciseControlState } from '../lib/exerciseControl';

const POLL_INTERVAL_MS = 5000;

export interface UseExerciseControlResult extends ExerciseControlState {
  runOp(op: string): void;
}

export function useExerciseControl(): UseExerciseControlResult {
  const controllerRef = useRef(createExerciseControlController());
  const [state, setState] = useState<ExerciseControlState>(() => controllerRef.current.getState());

  useEffect(() => {
    const controller = controllerRef.current;
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    void controller.poll();
    const timer = setInterval(() => { void controller.poll(); }, POLL_INTERVAL_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  return {
    ...state,
    runOp: (op: string) => { void controllerRef.current.runOp(op); },
  };
}
