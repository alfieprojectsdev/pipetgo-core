'use client'

import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/utils'
import { PricingMode } from '@prisma/client'
import { EditServiceModal } from './EditServiceModal'

interface LabService {
  id: string
  name: string
  category: string
  pricingMode: PricingMode
  pricePerUnit: number | null
  turnaroundDays: number | null
  active: boolean
  lab: {
    id: string
    name: string
  }
}

interface ApiResponse {
  items: LabService[]
  pagination: {
    page: number
    pageSize: number
    totalCount: number
    totalPages: number
    hasMore: boolean
  }
}

/**
 * Get badge color based on pricing mode
 */
function getPricingModeBadgeClass(mode: PricingMode): string {
  switch (mode) {
    case 'QUOTE_REQUIRED':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    case 'FIXED':
      return 'bg-green-100 text-green-800 border-green-200'
    case 'HYBRID':
      return 'bg-blue-100 text-blue-800 border-blue-200'
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200'
  }
}

/**
 * Format pricing mode for display
 */
function formatPricingMode(mode: PricingMode): string {
  switch (mode) {
    case 'QUOTE_REQUIRED':
      return 'Quote Required'
    case 'FIXED':
      return 'Fixed Price'
    case 'HYBRID':
      return 'Hybrid'
    default:
      return mode
  }
}

export function ServiceTable() {
  const { data: session } = useSession()
  const [services, setServices] = useState<LabService[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [labId, setLabId] = useState<string | null>(null)
  const [editServiceId, setEditServiceId] = useState<string | null>(null)

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkActionLoading, setBulkActionLoading] = useState(false)

  useEffect(() => {
    if (session?.user) {
      fetchLabId()
    }
  }, [session])

  useEffect(() => {
    if (labId) {
      fetchServices()
    }
  }, [labId])

  /**
   * Fetch the lab admin's lab ID
   */
  async function fetchLabId() {
    try {
      // Note: We need to fetch the lab ID for the current user
      // For now, we'll fetch all services and get the lab ID from the first service
      // In a production system, you might want a dedicated endpoint to get the user's lab
      const res = await fetch('/api/services?active=all&pageSize=1')
      if (!res.ok) throw new Error('Failed to fetch lab info')
      const data: ApiResponse = await res.json()
      if (data.items.length > 0) {
        setLabId(data.items[0].lab.id)
      } else {
        // No services yet, we need to handle this case
        setLabId('no-lab') // Placeholder to prevent infinite loading
        setLoading(false)
      }
    } catch (err) {
      console.error('Error fetching lab ID:', err)
      setError('Failed to load lab information')
      setLoading(false)
    }
  }

  /**
   * Fetch all services for the lab
   */
  async function fetchServices() {
    if (labId === 'no-lab') {
      setServices([])
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      const res = await fetch(`/api/services?labId=${labId}&active=all&pageSize=100`)
      if (!res.ok) throw new Error('Failed to fetch services')
      const data: ApiResponse = await res.json()
      setServices(data.items || [])
      setSelectedIds(new Set()) // Clear selection on refresh
      setError(null)
    } catch (err) {
      console.error('Error fetching services:', err)
      setError('Failed to load services')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Toggle service active status
   */
  async function toggleActive(serviceId: string, currentActive: boolean) {
    const newActive = !currentActive

    try {
      const res = await fetch(`/api/services/${serviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newActive })
      })

      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.error || 'Failed to update service')
      }

      toast.success(newActive ? 'Service enabled' : 'Service disabled')

      // Refresh services list
      fetchServices()
    } catch (err) {
      console.error('Error toggling service:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to update service')
    }
  }

  /**
   * Toggle select all services
   */
  function toggleSelectAll() {
    if (selectedIds.size === services.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(services.map(s => s.id)))
    }
  }

  /**
   * Toggle selection of a single service
   */
  function toggleSelectOne(serviceId: string) {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(serviceId)) {
      newSelected.delete(serviceId)
    } else {
      newSelected.add(serviceId)
    }
    setSelectedIds(newSelected)
  }

  /**
   * Perform bulk enable or disable action
   */
  async function performBulkAction(action: 'enable' | 'disable') {
    if (selectedIds.size === 0) {
      toast.error('No services selected')
      return
    }

    setBulkActionLoading(true)
    try {
      const res = await fetch('/api/services/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceIds: Array.from(selectedIds),
          action
        })
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Bulk operation failed')
      }

      const result = await res.json()
      toast.success(result.message)
      fetchServices()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to perform bulk action'
      toast.error(message)
    } finally {
      setBulkActionLoading(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-600">Loading services...</div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-600">{error}</div>
      </div>
    )
  }

  // Empty state
  if (services.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 bg-white rounded-lg border border-gray-200">
        <svg
          className="mx-auto h-12 w-12 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        <h3 className="mt-2 text-sm font-semibold text-gray-900">No services</h3>
        <p className="mt-1 text-sm text-gray-500">
          Get started by creating a new service.
        </p>
      </div>
    )
  }

  // Compute whether all services are selected
  const allSelected = services.length > 0 && selectedIds.size === services.length

  // Table display
  return (
    <div className="space-y-4">
      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <div className="text-sm font-medium text-blue-900">
            {selectedIds.size} service{selectedIds.size > 1 ? 's' : ''} selected
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => performBulkAction('enable')}
              disabled={bulkActionLoading}
            >
              Enable Selected
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => performBulkAction('disable')}
              disabled={bulkActionLoading}
            >
              Disable Selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkActionLoading}
            >
              Clear Selection
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all services"
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Pricing Mode</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Turnaround</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((service) => (
              <TableRow key={service.id}>
                <TableCell>
                  <Checkbox
                    checked={selectedIds.has(service.id)}
                    onCheckedChange={() => toggleSelectOne(service.id)}
                    aria-label={`Select ${service.name}`}
                  />
                </TableCell>
                <TableCell className="font-medium">{service.name}</TableCell>
                <TableCell>
                  <Badge variant="default" className="border">
                    {service.category}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge className={getPricingModeBadgeClass(service.pricingMode)}>
                    {formatPricingMode(service.pricingMode)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {service.pricePerUnit !== null
                    ? formatCurrency(Number(service.pricePerUnit))
                    : <span className="text-gray-500">Quote Required</span>}
                </TableCell>
                <TableCell>
                  {service.turnaroundDays
                    ? `${service.turnaroundDays} days`
                    : <span className="text-gray-500">N/A</span>}
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={service.active}
                    onCheckedChange={() => toggleActive(service.id, service.active)}
                    aria-label={`Toggle ${service.name} active status`}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditServiceId(service.id)}
                  >
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Edit Service Modal */}
      <EditServiceModal
        isOpen={editServiceId !== null}
        onClose={() => setEditServiceId(null)}
        onSuccess={() => {
          setEditServiceId(null)
          fetchServices()
        }}
        serviceId={editServiceId}
      />
    </div>
  )
}
