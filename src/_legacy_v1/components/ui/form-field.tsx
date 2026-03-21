/**
 * 🎓 LEARNING: FormField Component
 * ================================
 * Wrapper component for form inputs that provides:
 * - Label with required indicator
 * - Helper text
 * - Error message display
 *
 * v0.app UX Recommendation: Consistent form field layout with visual feedback
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface FormFieldProps {
  /** Form field ID - used to link label and input */
  id: string
  /** Label text */
  label: string
  /** Whether the field is required */
  required?: boolean
  /** Helper text shown below input (when no error) */
  helperText?: string
  /** Error message (replaces helperText when present) */
  error?: string
  /** Children (the input component) */
  children: React.ReactNode
  /** Additional className for the wrapper */
  className?: string
}

export function FormField({
  id,
  label,
  required = false,
  helperText,
  error,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {/* Label */}
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700"
      >
        {label}
        {required && (
          <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>
        )}
      </label>

      {/* Input (children) */}
      {children}

      {/* Helper text or error message */}
      {(error || helperText) && (
        <p
          className={cn(
            'text-xs',
            error ? 'text-red-600' : 'text-gray-500'
          )}
          id={error ? `${id}-error` : `${id}-helper`}
          role={error ? 'alert' : undefined}
        >
          {error || helperText}
        </p>
      )}
    </div>
  )
}
