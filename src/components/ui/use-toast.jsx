// Inspired by react-hot-toast library
import { useState, useEffect, createContext, useContext } from "react";
import { getCurrentRoute } from "@/lib/currentRoute";

// Keep toast UI calm: avoid "walls" of notifications.
const TOAST_LIMIT = 4;
const TOAST_REMOVE_DELAY = 3500;

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

const toastTimeouts = new Map();

const addToRemoveQueue = (toastId, delayMs = TOAST_REMOVE_DELAY) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: actionTypes.REMOVE_TOAST,
      toastId,
    });
  }, Math.max(250, Number(delayMs) || TOAST_REMOVE_DELAY));

  toastTimeouts.set(toastId, timeout);
};

const clearFromRemoveQueue = (toastId) => {
  const timeout = toastTimeouts.get(toastId);
  if (timeout) {
    clearTimeout(timeout);
    toastTimeouts.delete(toastId);
  }
};

export const reducer = (state, action) => {
  switch (action.type) {
    case actionTypes.ADD_TOAST:
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }
    case actionTypes.REMOVE_TOAST:
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners = [];

let memoryState = { toasts: [] };

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

// Urgency ramp → toast variant (color) + how long it lingers. The more urgent,
// the deeper the color (white→green→yellow→orange→red) and the longer it stays
// (base 3.5s, +2s per level). Callers pass `urgency` (0–4 or a name); an explicit
// `variant`/`duration` always wins.
const URGENCY_LEVELS = {
  info: 0, low: 0, none: 0,
  success: 1, good: 1,
  warning: 2, warn: 2, medium: 2,
  elevated: 3, high: 3, orange: 3,
  critical: 4, urgent: 4, destructive: 4, error: 4, danger: 4,
};
const URGENCY_VARIANT = ["default", "success", "warning", "elevated", "destructive"];
function resolveUrgency(urgency) {
  if (urgency === null || urgency === undefined) return null;
  const level = typeof urgency === "number"
    ? Math.max(0, Math.min(4, Math.round(urgency)))
    : (URGENCY_LEVELS[String(urgency).toLowerCase()] ?? null);
  if (level === null) return null;
  return { variant: URGENCY_VARIANT[level], duration: TOAST_REMOVE_DELAY + level * 2000 };
}

function toast({ id: providedId, duration, variant, urgency, ...props }) {
  const id = providedId ? String(providedId) : genId();
  // Derive color + lifetime from urgency when the caller didn't set them explicitly.
  const u = resolveUrgency(urgency);
  const resolvedVariant = variant ?? u?.variant;
  const resolvedDuration = typeof duration === "number" ? duration : u?.duration;
  if (resolvedVariant !== undefined) props.variant = resolvedVariant;
  duration = resolvedDuration;

  const update = (props) =>
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id },
    });

  const dismiss = () =>
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId: id });

  const existing = memoryState?.toasts?.find?.((t) => String(t?.id) === String(id));
  const nextToast = {
    ...props,
    id,
    // Remember where this toast was fired so clicking it can return the
    // user/admin to that location (unless the caller set an explicit
    // navigateTo). Captured here at creation time.
    originRoute: props.originRoute ?? getCurrentRoute(),
    open: true,
    onOpenChange: (open) => {
      if (!open) dismiss();
    },
  };

  if (existing) {
    // Update-in-place (dedupe) so bulk operations don't spam.
    clearFromRemoveQueue(id);
    dispatch({ type: actionTypes.UPDATE_TOAST, toast: nextToast });
  } else {
    dispatch({ type: actionTypes.ADD_TOAST, toast: nextToast });
  }

  addToRemoveQueue(id, typeof duration === "number" ? duration : TOAST_REMOVE_DELAY);

  return {
    id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = useState(memoryState);

  useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, [state]);

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: actionTypes.DISMISS_TOAST, toastId }),
  };
}

export { useToast, toast }; 