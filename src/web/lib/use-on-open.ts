import { useEffect, useRef } from "react";

/**
 * Runs `reset` when a dialog opens, not on every render while it is open. Pages refetch every few seconds, so
 * resetting on prop changes would wipe what the user is typing.
 */
export function useOnOpen(open: boolean, reset: () => void) {
  const latest = useRef(reset);
  latest.current = reset;
  useEffect(() => {
    if (open) latest.current();
  }, [open]);
}
