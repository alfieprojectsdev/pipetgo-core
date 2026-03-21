'use client'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createServiceSchema, serviceCategoryEnum, pricingModeEnum } from '@/lib/validations/service'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { toast } from 'sonner'
import type { z } from 'zod'

type EditServiceFormData = z.infer<typeof createServiceSchema>

interface EditServiceModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  serviceId: string | null
}

export function EditServiceModal({ isOpen, onClose, onSuccess, serviceId }: EditServiceModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(false)

  const form = useForm<EditServiceFormData>({
    resolver: zodResolver(createServiceSchema),
    defaultValues: {
      pricingMode: 'QUOTE_REQUIRED',
      unitType: 'per_sample'
    }
  })

  const pricingMode = form.watch('pricingMode')
  const showPriceField = pricingMode === 'FIXED' || pricingMode === 'HYBRID'

  // Fetch service data when modal opens
  useEffect(() => {
    if (isOpen && serviceId) {
      fetchServiceData()
    }
  }, [isOpen, serviceId])

  async function fetchServiceData() {
    if (!serviceId) return

    setLoading(true)
    try {
      const res = await fetch(`/api/services/${serviceId}`)
      if (!res.ok) throw new Error('Failed to fetch service')

      const service = await res.json()

      // Reset form with fetched data
      form.reset({
        name: service.name,
        description: service.description || '',
        category: service.category,
        pricingMode: service.pricingMode,
        pricePerUnit: service.pricePerUnit !== null ? Number(service.pricePerUnit) : undefined,
        unitType: service.unitType || 'per_sample',
        turnaroundDays: service.turnaroundDays || undefined,
        sampleRequirements: service.sampleRequirements || ''
      })
    } catch (error) {
      toast.error('Failed to load service data')
      onClose()
    } finally {
      setLoading(false)
    }
  }

  async function onSubmit(data: EditServiceFormData) {
    if (!serviceId) return

    setSubmitting(true)
    try {
      const res = await fetch(`/api/services/${serviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to update service')
      }

      toast.success('Service updated successfully')
      onSuccess()
      onClose()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update service'
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Service</DialogTitle>
          <DialogDescription>
            Update service information
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-gray-600">Loading service data...</div>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Service Name */}
            <div>
              <Label htmlFor="name">Service Name *</Label>
              <Input
                id="name"
                {...form.register('name')}
                placeholder="e.g., Water Quality Testing"
              />
              {form.formState.errors.name && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.name.message}
                </p>
              )}
            </div>

            {/* Category */}
            <div>
              <Label htmlFor="category">Category *</Label>
              <Select
                id="category"
                {...form.register('category')}
              >
                <option value="">Select category</option>
                {serviceCategoryEnum.options.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </Select>
              {form.formState.errors.category && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.category.message}
                </p>
              )}
            </div>

            {/* Pricing Mode */}
            <div>
              <Label>Pricing Mode *</Label>
              <div className="space-y-2 mt-2">
                {pricingModeEnum.options.map((mode) => (
                  <div key={mode} className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id={`pricing-${mode}`}
                      value={mode}
                      {...form.register('pricingMode')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                    />
                    <Label htmlFor={`pricing-${mode}`} className="font-normal cursor-pointer">
                      {mode === 'QUOTE_REQUIRED' && 'Quote Required (Custom pricing)'}
                      {mode === 'FIXED' && 'Fixed Price (Instant booking)'}
                      {mode === 'HYBRID' && 'Hybrid (Reference price OR custom quote)'}
                    </Label>
                  </div>
                ))}
              </div>
              {form.formState.errors.pricingMode && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.pricingMode.message}
                </p>
              )}
            </div>

            {/* Price (conditional) */}
            {showPriceField && (
              <div>
                <Label htmlFor="pricePerUnit">Price Per Unit *</Label>
                <Input
                  id="pricePerUnit"
                  type="number"
                  step="0.01"
                  {...form.register('pricePerUnit', { valueAsNumber: true })}
                  placeholder="e.g., 2500.00"
                />
                {form.formState.errors.pricePerUnit && (
                  <p className="text-sm text-red-600 mt-1">
                    {form.formState.errors.pricePerUnit.message}
                  </p>
                )}
              </div>
            )}

            {/* Unit Type */}
            <div>
              <Label htmlFor="unitType">Unit Type</Label>
              <Input
                id="unitType"
                {...form.register('unitType')}
                placeholder="per_sample"
              />
              {form.formState.errors.unitType && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.unitType.message}
                </p>
              )}
            </div>

            {/* Turnaround Days */}
            <div>
              <Label htmlFor="turnaroundDays">Estimated Turnaround (days)</Label>
              <Input
                id="turnaroundDays"
                type="number"
                {...form.register('turnaroundDays', { valueAsNumber: true })}
                placeholder="e.g., 5"
              />
              {form.formState.errors.turnaroundDays && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.turnaroundDays.message}
                </p>
              )}
            </div>

            {/* Description */}
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                {...form.register('description')}
                placeholder="Describe what this service tests for..."
                rows={3}
              />
              {form.formState.errors.description && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.description.message}
                </p>
              )}
            </div>

            {/* Sample Requirements */}
            <div>
              <Label htmlFor="sampleRequirements">Sample Requirements</Label>
              <Textarea
                id="sampleRequirements"
                {...form.register('sampleRequirements')}
                placeholder="e.g., 500ml water sample in sterile container"
                rows={2}
              />
              {form.formState.errors.sampleRequirements && (
                <p className="text-sm text-red-600 mt-1">
                  {form.formState.errors.sampleRequirements.message}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Updating...' : 'Update Service'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
