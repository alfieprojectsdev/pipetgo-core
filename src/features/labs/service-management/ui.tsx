'use client'

import { useActionState } from 'react'
import { PricingMode, ServiceCategory } from '@prisma/client'
import {
  createService,
  updateService,
  toggleServiceActive,
  type ServiceFormState,
} from './action'

const initialState: ServiceFormState = {}

export function CreateServiceForm() {
  const [state, formAction, pending] = useActionState(createService, initialState)
  return <ServiceForm state={state} formAction={formAction} pending={pending} />
}

export function EditServiceForm({
  serviceId,
  defaults,
}: {
  serviceId: string
  defaults: {
    name: string
    description?: string
    category: ServiceCategory
    pricingMode: PricingMode
    pricePerUnit?: string
    unit?: string
  }
}) {
  const [state, formAction, pending] = useActionState(updateService, initialState)
  return (
    <ServiceForm
      state={state}
      formAction={formAction}
      pending={pending}
      serviceId={serviceId}
      defaults={defaults}
    />
  )
}

export function ToggleActiveForm({
  serviceId,
  isActive,
}: {
  serviceId: string
  isActive: boolean
}) {
  const [state, formAction, pending] = useActionState(toggleServiceActive, initialState)
  return (
    <form action={formAction}>
      <input type="hidden" name="serviceId" value={serviceId} />
      {state.message && <p role="alert">{state.message}</p>}
      <button type="submit" disabled={pending}>
        {pending ? '…' : isActive ? 'Deactivate' : 'Reactivate'}
      </button>
    </form>
  )
}

function ServiceForm({
  state,
  formAction,
  pending,
  serviceId,
  defaults,
}: {
  state: ServiceFormState
  formAction: (payload: FormData) => void
  pending: boolean
  serviceId?: string
  defaults?: {
    name?: string
    description?: string
    category?: ServiceCategory
    pricingMode?: PricingMode
    pricePerUnit?: string
    unit?: string
  }
}) {
  return (
    <form action={formAction}>
      {serviceId && <input type="hidden" name="serviceId" value={serviceId} />}
      {state.message && <p role="alert">{state.message}</p>}

      <div>
        <label htmlFor="name">Service name</label>
        <input id="name" name="name" defaultValue={defaults?.name} required />
        {state.errors?.name && <p>{state.errors.name[0]}</p>}
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" defaultValue={defaults?.description} />
        {state.errors?.description && <p>{state.errors.description[0]}</p>}
      </div>

      <div>
        <label htmlFor="category">Category</label>
        <select id="category" name="category" defaultValue={defaults?.category} required>
          {Object.values(ServiceCategory).map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        {state.errors?.category && <p>{state.errors.category[0]}</p>}
      </div>

      <div>
        <label htmlFor="pricingMode">Pricing mode</label>
        <select id="pricingMode" name="pricingMode" defaultValue={defaults?.pricingMode} required>
          {Object.values(PricingMode).map((m) => (
            <option key={m} value={m}>
              {m.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        {state.errors?.pricingMode && <p>{state.errors.pricingMode[0]}</p>}
      </div>

      <div>
        <label htmlFor="pricePerUnit">Price per unit</label>
        <input
          id="pricePerUnit"
          name="pricePerUnit"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults?.pricePerUnit}
        />
        {state.errors?.pricePerUnit && <p>{state.errors.pricePerUnit[0]}</p>}
      </div>

      <div>
        <label htmlFor="unit">Unit</label>
        <input id="unit" name="unit" defaultValue={defaults?.unit} />
        {state.errors?.unit && <p>{state.errors.unit[0]}</p>}
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : serviceId ? 'Save changes' : 'Create service'}
      </button>
    </form>
  )
}
