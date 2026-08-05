import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { applyRouteDocumentMetadata } from './routeDocumentMetadata.js'

export default function RouteDocumentMetadata() {
  const { pathname } = useLocation()

  useLayoutEffect(() => {
    applyRouteDocumentMetadata(pathname)
  }, [pathname])

  return null
}
