import { createContext, useContext } from "react";
import type { EditorStore } from "./store";

export const StoreContext = createContext<EditorStore | null>(null);

export function useStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreContext missing — wrap the app in <StoreContext.Provider>");
  return store;
}
