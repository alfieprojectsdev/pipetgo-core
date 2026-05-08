'use client'

import { useActionState } from 'react'
import { registerLab, type OnboardingState } from './action'

const initialState: OnboardingState = {}

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(registerLab, initialState)

  return (
    <form action={formAction}>
      {state.message && <p role="alert">{state.message}</p>}

      <div>
        <label htmlFor="name">Lab name</label>
        <input id="name" name="name" required />
        {state.errors?.name && <p>{state.errors.name[0]}</p>}
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" />
        {state.errors?.description && <p>{state.errors.description[0]}</p>}
      </div>

      <div>
        <label htmlFor="city">City</label>
        <input id="city" name="city" required />
        {state.errors?.city && <p>{state.errors.city[0]}</p>}
      </div>

      <div>
        <label htmlFor="country">Country</label>
        <input id="country" name="country" required />
        {state.errors?.country && <p>{state.errors.country[0]}</p>}
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Registering…' : 'Register lab'}
      </button>
    </form>
  )
}
