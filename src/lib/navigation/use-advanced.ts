import { useCallback, useEffect, useState } from "react";
import { ADVANCED_KEY } from "./model";
import { readLocal, writeLocal } from "./local-storage";

const EVENT = "meridian-advanced-change";

/**
 * Whether this browser shows the advanced screens. Off until a person turns it on in Settings. It is a display choice only: every
 * screen keeps its own role checks on the server, and a hidden screen still opens by its address.
 */
export function useAdvanced(): [boolean, (next: boolean) => void] {
  // Off on the server and on first paint, then read from storage, so the server and the browser render the same thing.
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    const read = () => setAdvanced(readLocal(ADVANCED_KEY) === "on");
    read();
    window.addEventListener(EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    writeLocal(ADVANCED_KEY, next ? "on" : "off");
    setAdvanced(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [advanced, set];
}
