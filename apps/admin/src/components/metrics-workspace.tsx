'use client'

import { useEffect, useState } from 'react'
import { defaultMetricsRange } from '../lib/metrics-definitions'
import { useOwnerSession } from './session-provider'
import { Workspace } from './workspace'
import { MetricsView } from './metrics-view'

export function MetricsWorkspace() {
  const { snapshot, client } = useOwnerSession()
  const [range, setRange] = useState(() => defaultMetricsRange())
  useEffect(() => {
    if (snapshot.status === 'authenticated' && snapshot.metrics.status === 'idle') void client?.loadMetrics(defaultMetricsRange())
  }, [client, snapshot.status, snapshot.metrics.status])
  return <Workspace page="metrics"><MetricsView snapshot={snapshot.metrics} range={range} onRangeChange={setRange} onRefresh={() => { void client?.loadMetrics(range) }} /></Workspace>
}
