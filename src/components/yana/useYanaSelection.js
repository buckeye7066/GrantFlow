import { useContext } from 'react'
import { YanaSelectionContextRaw } from './YanaSelectionContext.jsx'

/**
 * Hook accessor for YanaSelectionContext. Lives in its own file so
 * react-refresh can hot-reload the context provider component without
 * tearing the hook's reference.
 */
export function useYanaSelection() {
  return useContext(YanaSelectionContextRaw)
}
