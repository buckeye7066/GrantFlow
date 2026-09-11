import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { createPageUrl } from '@/utils'

/**
 * In-app catch-all. Before this existed an unknown path inside the signed-in
 * layout (production 2026-09-11: /CreateProfile from the Pricing page) rendered
 * the app chrome around an empty page with no explanation.
 */
export default function NotFound() {
  const location = useLocation()
  return (
    <div className="p-6 md:p-8">
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            There is no page at <code className="break-all">{location.pathname}</code>. The link that brought you here may be out of date.
          </p>
          <Button asChild>
            <Link to={createPageUrl('Dashboard')}>Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
