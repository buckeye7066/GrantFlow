import { useContext } from 'react'
import { HamiltonSelectionContextRaw } from './HamiltonSelectionContext.jsx'

/**
 * Hook accessor for HamiltonSelectionContext. Lives in its own file so
 * react-refresh can hot-reload the context provider component without
 * tearing the hook's reference.
 */
export function useHamiltonSelection() {
  return useContext(HamiltonSelectionContextRaw)
}
